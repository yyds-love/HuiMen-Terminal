use std::fs::OpenOptions;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{self, Command, Stdio};
use std::sync::OnceLock;

use tauri_plugin_os::Version;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Console::{
    AttachConsole, WriteConsoleInputW, INPUT_RECORD, INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD,
    KEY_EVENT_RECORD_0, LEFT_ALT_PRESSED, LEFT_CTRL_PRESSED, SHIFT_PRESSED,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{WaitForSingleObject, DETACHED_PROCESS};

const HELPER_ARG: &str = "--windows-console-key";
const HELPER_TIMEOUT_MS: u32 = 500;

#[derive(Clone, Copy)]
struct ConsoleKey {
    name: &'static str,
    bytes: &'static [u8],
    virtual_key: u16,
    scan_code: u16,
    character: u8,
    modifiers: u32,
}

const CONSOLE_KEYS: [ConsoleKey; 4] = [
    ConsoleKey {
        name: "shift-tab",
        bytes: b"\x1b[Z",
        virtual_key: 0x09, // VK_TAB
        scan_code: 0x0f,
        character: b'\t',
        modifiers: SHIFT_PRESSED,
    },
    ConsoleKey {
        name: "shift-enter",
        bytes: b"\x1b\r",
        virtual_key: 0x0d, // VK_RETURN
        scan_code: 0x1c,
        character: b'\n',
        modifiers: SHIFT_PRESSED,
    },
    ConsoleKey {
        name: "alt-enter",
        bytes: b"\x1b\r",
        virtual_key: 0x0d, // VK_RETURN
        scan_code: 0x1c,
        character: b'\r',
        modifiers: LEFT_ALT_PRESSED,
    },
    ConsoleKey {
        name: "ctrl-j",
        bytes: b"\n",
        virtual_key: b'J' as u16,
        scan_code: 0x24,
        character: b'\n',
        modifiers: LEFT_CTRL_PRESSED,
    },
];

impl ConsoleKey {
    fn from_name(name: &str) -> Option<Self> {
        CONSOLE_KEYS.into_iter().find(|key| key.name == name)
    }

    fn records(self) -> [INPUT_RECORD; 2] {
        [1, 0].map(|down| INPUT_RECORD {
            EventType: KEY_EVENT as u16,
            Event: INPUT_RECORD_0 {
                KeyEvent: KEY_EVENT_RECORD {
                    bKeyDown: down,
                    wRepeatCount: 1,
                    wVirtualKeyCode: self.virtual_key,
                    wVirtualScanCode: self.scan_code,
                    uChar: KEY_EVENT_RECORD_0 {
                        UnicodeChar: u16::from(self.character),
                    },
                    dwControlKeyState: self.modifiers,
                },
            },
        })
    }
}

fn affected_version(version: Version) -> bool {
    // System ConPTY on Windows 10 1809 loses modifiers for these keys.
    matches!(version, Version::Semantic(10, 0, 17_763))
}

pub(super) fn try_write(shell_pid: u32, bytes: &[u8], name: &str) -> io::Result<bool> {
    let key = ConsoleKey::from_name(name)
        .filter(|key| key.bytes == bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid console key"))?;
    static NEEDS_NATIVE_KEYS: OnceLock<bool> = OnceLock::new();
    if !*NEEDS_NATIVE_KEYS.get_or_init(|| affected_version(tauri_plugin_os::version())) {
        return Ok(false);
    }
    if shell_pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "shell process unavailable",
        ));
    }

    // AttachConsole affects the whole process. Keep it in a detached child so
    // desktop windows and other terminal sessions keep their own console state.
    let mut child = Command::new(std::env::current_exe()?)
        .arg(HELPER_ARG)
        .arg(shell_pid.to_string())
        .arg(key.name)
        .creation_flags(DETACHED_PROCESS)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    match unsafe { WaitForSingleObject(child.as_raw_handle(), HELPER_TIMEOUT_MS) } {
        WAIT_OBJECT_0 => match child.wait()?.code() {
            Some(0) => Ok(true),
            Some(code) => Err(io::Error::from_raw_os_error(code)),
            None => Err(io::Error::other(
                "Windows console key helper exited unexpectedly",
            )),
        },
        wait => {
            let error = if wait == WAIT_TIMEOUT {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Windows console key helper timed out",
                )
            } else {
                io::Error::last_os_error()
            };
            let _ = child.kill();
            Err(error)
        }
    }
}

/// Called before starting Tauri. The detached helper sends one key to its PTY.
pub fn run_console_key_helper() {
    let mut args = std::env::args_os().skip(1);
    if !args.next().is_some_and(|arg| arg == HELPER_ARG) {
        return;
    }
    let pid = args
        .next()
        .and_then(|arg| arg.to_str()?.parse::<u32>().ok());
    let key = args
        .next()
        .and_then(|arg| ConsoleKey::from_name(arg.to_str()?));
    let (Some(pid), Some(key), None) = (pid.filter(|&pid| pid != 0), key, args.next()) else {
        process::exit(ERROR_INVALID_PARAMETER as i32);
    };
    let code = write_console_key(pid, key)
        .err()
        .map_or(0, |error| error.raw_os_error().unwrap_or(1));
    process::exit(code);
}

fn check_console_owner(pid: u32) -> io::Result<()> {
    // The shell and this helper are children of the same application process.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry = PROCESSENTRY32 {
        dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
        ..Default::default()
    };
    let helper_pid = process::id();
    let mut shell_parent = None;
    let mut helper_parent = None;
    let mut found = unsafe { Process32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32ProcessID == pid {
            shell_parent = Some(entry.th32ParentProcessID);
        } else if entry.th32ProcessID == helper_pid {
            helper_parent = Some(entry.th32ParentProcessID);
        }
        if let (Some(shell_parent), Some(helper_parent)) = (shell_parent, helper_parent) {
            if shell_parent != 0 && shell_parent == helper_parent {
                return Ok(());
            }
            break;
        }
        found = unsafe { Process32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32))
}

fn write_console_key(pid: u32, key: ConsoleKey) -> io::Result<()> {
    check_console_owner(pid)?;
    if unsafe { AttachConsole(pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Open the attached console's input even when the helper's stdin is NUL.
    let input = OpenOptions::new()
        .write(true)
        .share_mode(3) // FILE_SHARE_READ | FILE_SHARE_WRITE
        .open("CONIN$")?;
    let keys = key.records();
    let mut written = 0;
    let count = keys.len() as u32;
    if unsafe { WriteConsoleInputW(input.as_raw_handle(), keys.as_ptr(), count, &mut written) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if written != count {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "Windows console accepted an incomplete key event",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_records_preserve_each_keys_modifiers() {
        let cases = [
            ("shift-tab", b"\x1b[Z".as_slice(), 0x09, 0x0f, b'\t', 0x10),
            ("shift-enter", b"\x1b\r".as_slice(), 0x0d, 0x1c, b'\n', 0x10),
            ("alt-enter", b"\x1b\r".as_slice(), 0x0d, 0x1c, b'\r', 0x02),
            ("ctrl-j", b"\n".as_slice(), 0x4a, 0x24, b'\n', 0x08),
        ];
        for (name, data, vk, scan, ch, modifiers) in cases {
            let key = ConsoleKey::from_name(name).expect("known key");
            assert_eq!(key.bytes, data);
            for (index, record) in key.records().into_iter().enumerate() {
                assert_eq!(record.EventType, KEY_EVENT as u16);
                let event = unsafe { record.Event.KeyEvent };
                assert_eq!(event.bKeyDown, i32::from(index == 0));
                assert_eq!(event.wRepeatCount, 1);
                assert_eq!(event.wVirtualKeyCode, vk);
                assert_eq!(event.wVirtualScanCode, scan);
                assert_eq!(unsafe { event.uChar.UnicodeChar }, u16::from(ch));
                assert_eq!(event.dwControlKeyState, modifiers);
            }
        }
        assert!(ConsoleKey::from_name("enter").is_none());
    }

    #[test]
    fn native_input_is_limited_to_the_affected_windows_build() {
        assert!(affected_version(Version::Semantic(10, 0, 17_763)));
        assert!(!affected_version(Version::Semantic(10, 0, 19_045)));
        assert!(!affected_version(Version::Semantic(10, 0, 22_631)));
        assert!(!affected_version(Version::Unknown));
    }
}
