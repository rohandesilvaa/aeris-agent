mod database;
mod inference;
mod models;
mod voice;

use database::{initialize, DatabaseState};
use inference::{GenerationState, ServerState};
use rusqlite::Connection;
use std::{fs, sync::Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState::default())
        .manage(voice::VoiceServerState::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let connection = Connection::open(data_dir.join("aeris.sqlite3"))?;
            initialize(&connection)?;
            app.manage(DatabaseState(Mutex::new(connection)));
            app.manage(GenerationState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            inference::start_server,
            inference::stop_server,
            inference::check_server,
            inference::stream_chat,
            inference::cancel_generation,
            database::list_chats,
            database::create_chat,
            database::get_chat_messages,
            database::rename_chat,
            database::delete_chat,
            database::clear_chat,
            database::import_legacy_messages,
            voice::prepare_voice_server,
            voice::transcribe_audio,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aeris")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Ok(mut process) = app.state::<ServerState>().0.lock() {
                    if let Some(mut child) = process.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
                voice::stop_managed_server(&app.state::<voice::VoiceServerState>());
            }
        });
}
