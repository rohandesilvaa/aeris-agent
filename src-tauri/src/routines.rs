//! Routines: work a teammate does on a schedule, in its own thread. They run
//! only while the app is open; one missed run is caught up at the next start.

use crate::{
    database::{now_ms, DatabaseState},
    inference::{self, ApprovalState, GenerationState},
    models::{ChatRequest, StreamEvent},
    settings,
};
use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone, Timelike};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Mutex};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    /// What the teammate is asked to do each time.
    pub prompt: String,
    /// `hourly`, `daily`, `weekdays`, or `weekly`.
    pub schedule: String,
    /// `HH:MM`. For `hourly` only the minutes are used.
    pub time: String,
    /// 0 is Monday. Used by `weekly`.
    pub weekday: u32,
    pub enabled: bool,
    /// May write files in the workspace without asking. Commands never run.
    pub allow_writes: bool,
    pub chat_id: Option<String>,
    pub last_run: Option<i64>,
    pub last_status: String,
    pub next_run: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInput {
    #[serde(default)]
    pub id: Option<String>,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: String,
    pub time: String,
    #[serde(default)]
    pub weekday: u32,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub allow_writes: bool,
}

fn enabled() -> bool {
    true
}

/// Routines being run right now, so the scheduler never starts one twice.
#[derive(Default)]
pub struct RunningRoutines(Mutex<HashSet<String>>);

const COLUMNS: &str = "id, bot_id, title, prompt, schedule, time, weekday, enabled, allow_writes, chat_id, last_run, last_status, next_run";

fn row_to_routine(row: &rusqlite::Row<'_>) -> rusqlite::Result<Routine> {
    Ok(Routine {
        id: row.get(0)?,
        bot_id: row.get(1)?,
        title: row.get(2)?,
        prompt: row.get(3)?,
        schedule: row.get(4)?,
        time: row.get(5)?,
        weekday: row.get(6)?,
        enabled: row.get(7)?,
        allow_writes: row.get(8)?,
        chat_id: row.get(9)?,
        last_run: row.get(10)?,
        last_status: row.get(11)?,
        next_run: row.get(12)?,
    })
}

/// The first moment after `after` that matches the schedule, in local time.
pub fn next_run(schedule: &str, time: &str, weekday: u32, after: DateTime<Local>) -> DateTime<Local> {
    let at = NaiveTime::parse_from_str(time, "%H:%M").unwrap_or(NaiveTime::MIN);
    if schedule == "hourly" {
        let this_hour = after
            .with_minute(at.minute())
            .and_then(|moment| moment.with_second(0))
            .and_then(|moment| moment.with_nanosecond(0))
            .unwrap_or(after);
        return if this_hour > after { this_hour } else { this_hour + Duration::hours(1) };
    }
    for days_ahead in 0..=7 {
        let date = after.date_naive() + Duration::days(days_ahead);
        let day = date.weekday().num_days_from_monday();
        let wanted = match schedule {
            "weekdays" => day < 5,
            "weekly" => day == weekday % 7,
            _ => true,
        };
        if !wanted {
            continue;
        }
        if let Some(moment) = Local.from_local_datetime(&date.and_time(at)).earliest() {
            if moment > after {
                return moment;
            }
        }
    }
    after + Duration::days(1)
}

fn all(state: &State<'_, DatabaseState>) -> Result<Vec<Routine>, String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    let mut statement = connection
        .prepare(&format!("SELECT {COLUMNS} FROM routines ORDER BY next_run"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_routine)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn list_routines(state: State<'_, DatabaseState>) -> Result<Vec<Routine>, String> {
    all(&state)
}

#[tauri::command]
pub fn save_routine(input: RoutineInput, state: State<'_, DatabaseState>) -> Result<(), String> {
    let title: String = input.title.trim().chars().take(60).collect();
    let prompt: String = input.prompt.trim().chars().take(4_000).collect();
    if title.is_empty() {
        return Err("Give the routine a name.".into());
    }
    if prompt.is_empty() {
        return Err("Say what the teammate should do.".into());
    }
    if !["hourly", "daily", "weekdays", "weekly"].contains(&input.schedule.as_str()) {
        return Err("Choose how often the routine runs.".into());
    }
    if NaiveTime::parse_from_str(&input.time, "%H:%M").is_err() {
        return Err("Set the time as hours and minutes.".into());
    }
    let next = next_run(&input.schedule, &input.time, input.weekday, Local::now()).timestamp_millis();
    let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute(
            "INSERT INTO routines (id, bot_id, title, prompt, schedule, time, weekday, enabled, allow_writes, next_run)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET bot_id = ?2, title = ?3, prompt = ?4, schedule = ?5, time = ?6,
                weekday = ?7, enabled = ?8, allow_writes = ?9, next_run = ?10",
            params![id, input.bot_id, title, prompt, input.schedule, input.time, input.weekday % 7, input.enabled, input.allow_writes, next],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_routine(routine_id: String, state: State<'_, DatabaseState>) -> Result<(), String> {
    let connection = state.0.lock().map_err(|_| "Could not lock the database")?;
    connection
        .execute("DELETE FROM routines WHERE id = ?1", [routine_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn run_routine_now(routine_id: String, app: AppHandle) -> Result<(), String> {
    let routine = all(&app.state::<DatabaseState>())?
        .into_iter()
        .find(|routine| routine.id == routine_id)
        .ok_or("That routine no longer exists.")?;
    start(&app, routine);
    Ok(())
}

/// Checks twice a minute for routines that are due and runs them.
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let Ok(routines) = all(&app.state::<DatabaseState>()) else {
                continue;
            };
            let now = now_ms();
            for routine in routines {
                if routine.enabled && routine.next_run <= now {
                    start(&app, routine);
                }
            }
        }
    });
}

/// Runs one routine in the background unless it is already running.
fn start(app: &AppHandle, routine: Routine) {
    {
        let running = app.state::<RunningRoutines>();
        let Ok(mut running) = running.0.lock() else {
            return;
        };
        if !running.insert(routine.id.clone()) {
            return;
        }
    }
    // Move the schedule on first, so a long or failing run is not retried
    // every tick.
    let next = next_run(&routine.schedule, &routine.time, routine.weekday, Local::now()).timestamp_millis();
    if let Ok(connection) = app.state::<DatabaseState>().0.lock() {
        let _ = connection.execute(
            "UPDATE routines SET next_run = ?1, last_status = 'Running' WHERE id = ?2",
            params![next, routine.id],
        );
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run(&app, &routine).await;
        let (chat_id, status) = match outcome {
            Ok(chat_id) => (Some(chat_id), "Done".to_string()),
            Err(message) => (routine.chat_id.clone(), format!("Failed: {message}")),
        };
        if let Ok(connection) = app.state::<DatabaseState>().0.lock() {
            let _ = connection.execute(
                "UPDATE routines SET last_run = ?1, last_status = ?2, chat_id = COALESCE(?3, chat_id) WHERE id = ?4",
                params![now_ms(), status, chat_id, routine.id],
            );
        }
        if let Ok(mut running) = app.state::<RunningRoutines>().0.lock() {
            running.remove(&routine.id);
        }
        let _ = app.emit(
            "routine-finished",
            serde_json::json!({ "routineId": routine.id, "chatId": chat_id, "botId": routine.bot_id, "title": routine.title, "status": status }),
        );
    });
}

/// Posts the routine's request in its thread and waits for the reply.
async fn run(app: &AppHandle, routine: &Routine) -> Result<String, String> {
    let database = app.state::<DatabaseState>();
    let saved = settings::load(&database);
    // Each routine keeps one thread; make it on the first run, or again if
    // Rohan deleted it.
    let chat_id = {
        let connection = database.0.lock().map_err(|_| "Could not lock the database")?;
        let existing = routine.chat_id.clone().filter(|chat_id| {
            connection
                .query_row("SELECT COUNT(*) FROM chats WHERE id = ?1", [chat_id], |row| row.get::<_, i64>(0))
                .map(|count| count > 0)
                .unwrap_or(false)
        });
        match existing {
            Some(chat_id) => chat_id,
            None => {
                let chat_id = Uuid::new_v4().to_string();
                connection
                    .execute(
                        "INSERT INTO chats (id, title, created_at, updated_at, bot_id) VALUES (?1, ?2, ?3, ?3, ?4)",
                        params![chat_id, routine.title, now_ms(), routine.bot_id],
                    )
                    .map_err(|error| error.to_string())?;
                chat_id
            }
        }
    };
    let request = ChatRequest {
        request_id: Uuid::new_v4().to_string(),
        chat_id: chat_id.clone(),
        user_message_id: Uuid::new_v4().to_string(),
        assistant_message_id: Uuid::new_v4().to_string(),
        content: routine.prompt.clone(),
        persona_prompt: saved.persona_prompt,
        claude_binary_path: saved.claude_binary_path,
        claude_model: saved.claude_model,
        team_mode: false,
        workspace_dir: saved.workspace_dir,
        unattended: true,
        unattended_writes: routine.allow_writes,
    };
    // Nobody is watching the stream; the finished reply is read from the thread.
    let unwatched: Channel<StreamEvent> = Channel::new(|_| Ok(()));
    let generations = app.state::<GenerationState>();
    let approvals = app.state::<ApprovalState>();
    inference::answer_message(&request, &unwatched, app, &database, &generations, &approvals)
        .await?
        .ok_or("The routine was stopped before it replied.")?;
    Ok(chat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(year, month, day, hour, minute, 0).unwrap()
    }

    #[test]
    fn daily_runs_today_if_the_time_is_still_ahead_otherwise_tomorrow() {
        // 2026-11-16 is a Monday.
        assert_eq!(next_run("daily", "09:00", 0, at(2026, 11, 16, 8, 0)), at(2026, 11, 16, 9, 0));
        assert_eq!(next_run("daily", "09:00", 0, at(2026, 11, 16, 9, 0)), at(2026, 11, 17, 9, 0));
    }

    #[test]
    fn weekdays_skip_the_weekend_and_weekly_waits_for_its_day() {
        let friday_evening = at(2026, 11, 20, 18, 0);
        assert_eq!(next_run("weekdays", "07:30", 0, friday_evening), at(2026, 11, 23, 7, 30));
        // weekday 6 is Sunday
        assert_eq!(next_run("weekly", "20:00", 6, friday_evening), at(2026, 11, 22, 20, 0));
        let sunday_after = at(2026, 11, 22, 20, 0);
        assert_eq!(next_run("weekly", "20:00", 6, sunday_after), at(2026, 11, 29, 20, 0));
    }

    #[test]
    fn hourly_uses_only_the_minutes() {
        assert_eq!(next_run("hourly", "00:15", 0, at(2026, 11, 16, 8, 0)), at(2026, 11, 16, 8, 15));
        assert_eq!(next_run("hourly", "00:15", 0, at(2026, 11, 16, 8, 15)), at(2026, 11, 16, 9, 15));
    }
}
