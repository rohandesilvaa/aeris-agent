mod agents;
mod claude_code;
mod database;
mod inference;
mod memory;
mod models;
mod plugins;
mod routines;
mod settings;
mod skills;
mod speech;
mod voice;

use database::{initialize, DatabaseState};
use inference::GenerationState;
use rusqlite::Connection;
use std::{fs, sync::Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(voice::VoiceServerState::default())
        .manage(speech::SpeechState::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let connection = Connection::open(data_dir.join("aeris.sqlite3"))?;
            initialize(&connection)?;
            app.manage(DatabaseState(Mutex::new(connection)));
            app.manage(GenerationState::default());
            app.manage(inference::ApprovalState::default());
            app.manage(routines::RunningRoutines::default());
            routines::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude_code::check_claude_code,
            inference::default_persona,
            inference::stream_chat,
            inference::cancel_generation,
            inference::answer_approval,
            inference::workspace_path,
            inference::open_workspace,
            database::list_chats,
            database::create_chat,
            database::create_group,
            database::get_chat_messages,
            database::rename_chat,
            database::delete_chat,
            database::get_agent_steps,
            database::list_bots,
            database::create_bot,
            database::update_bot,
            database::delete_bot,
            plugins::list_plugins,
            plugins::save_plugin,
            plugins::delete_plugin,
            plugins::test_plugin,
            skills::list_skills,
            skills::save_skill,
            skills::delete_skill,
            skills::draft_skill,
            routines::list_routines,
            routines::save_routine,
            routines::delete_routine,
            routines::run_routine_now,
            settings::sync_settings,
            speech::list_voices,
            speech::speak,
            speech::stop_speaking,
            voice::prepare_voice_server,
            voice::transcribe_audio,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Aeris Bot")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                voice::stop_managed_server(&app.state::<voice::VoiceServerState>());
            }
        });
}
