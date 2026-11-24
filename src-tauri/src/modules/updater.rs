use std::future::Future;
use std::time::Duration;
use tauri::{ipc::Channel, Manager, State, Webview};
use tauri_plugin_updater::Update;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct UpdaterState(Mutex<bool>);

impl UpdaterState {
    async fn install_once<F>(&self, install: F) -> Result<(), String>
    where
        F: Future<Output = Result<(), String>>,
    {
        let mut installed = self
            .0
            .try_lock()
            .map_err(|_| "另一个窗口正在安装更新，请稍候。".to_string())?;
        if *installed {
            return Ok(());
        }
        install.await?;
        *installed = true;
        Ok(())
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// Keep signature verification and platform installation in Tauri's updater,
/// while coordinating all windows for the lifetime of the native operation.
#[tauri::command]
pub async fn updater_install(
    webview: Webview,
    state: State<'_, UpdaterState>,
    rid: u32,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let resource = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| error.to_string())?;
    let mut update = (*resource).clone();
    update.timeout = Some(Duration::from_secs(10 * 60));
    state
        .install_once(async move {
            let mut started = false;
            update
                .download_and_install(
                    |chunk_length, content_length| {
                        if !started {
                            started = true;
                            let _ = on_event.send(DownloadEvent::Started { content_length });
                        }
                        let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                    },
                    || {
                        let _ = on_event.send(DownloadEvent::Finished);
                    },
                )
                .await
                .map_err(|error| error.to_string())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn rejects_overlapping_installation_from_another_window() {
        let state = UpdaterState::default();
        let first = state.install_once(std::future::pending());
        tokio::pin!(first);
        tokio::select! {
            _ = &mut first => panic!("installation should be pending"),
            _ = tokio::task::yield_now() => {}
        }
        let attempts = AtomicUsize::new(0);
        let result = state
            .install_once(async {
                attempts.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn failed_installation_can_be_retried() {
        let state = UpdaterState::default();
        assert!(state
            .install_once(async { Err("bad signature".into()) })
            .await
            .is_err());
        assert!(state.install_once(async { Ok(()) }).await.is_ok());
    }

    #[tokio::test]
    async fn successful_installation_is_not_repeated_by_another_window() {
        let state = UpdaterState::default();
        let attempts = AtomicUsize::new(0);
        for _ in 0..2 {
            state
                .install_once(async {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap();
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelled_future_releases_the_installation_guard() {
        let state = UpdaterState::default();
        {
            let first = state.install_once(std::future::pending());
            tokio::pin!(first);
            tokio::select! {
                _ = &mut first => panic!("installation should be pending"),
                _ = tokio::task::yield_now() => {}
            }
        }
        assert!(state.install_once(async { Ok(()) }).await.is_ok());
    }
}
