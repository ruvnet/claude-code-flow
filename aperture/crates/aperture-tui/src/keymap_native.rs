use crossterm::event::KeyCode;

use crate::app::AppState;

pub async fn handle_key(state: &mut AppState, code: KeyCode) {
    match code {
        KeyCode::Esc => state.should_quit = true,
        KeyCode::Backspace => {
            state.input.pop();
        }
        KeyCode::Char(c) => state.input.push(c),
        _ => {}
    }
}
