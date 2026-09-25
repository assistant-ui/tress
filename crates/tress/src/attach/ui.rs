//! A terminal view of the shared thread. Host updates never replace the draft.

use std::io;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEventKind, KeyModifiers,
    MouseEventKind,
};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    DefaultTerminal, Frame,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::ThreadState;
use crate::commands;

const BG: Color = Color::Rgb(9, 9, 9);
const TEXT: Color = Color::Rgb(214, 214, 211);
const MUTED: Color = Color::Rgb(146, 146, 141);
const BORDER: Color = Color::Rgb(48, 48, 48);
const ACCENT: Color = Color::Rgb(206, 149, 124);

pub enum Action {
    Submit(String),
    Exit,
}

#[derive(Default)]
struct Editor {
    text: String,
    cursor: usize,
    history: Vec<String>,
    history_index: Option<usize>,
    saved_draft: String,
}

impl Editor {
    fn set(&mut self, text: String) {
        self.cursor = text.len();
        self.text = text;
    }

    fn previous(&self) -> usize {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map_or(0, |(i, _)| i)
    }

    fn next(&self) -> usize {
        self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map_or(self.cursor, |g| self.cursor + g.len())
    }

    fn insert(&mut self, text: &str) {
        // Paste is one draft, never a sequence of submitted commands. Drop
        // terminal control characters before they enter the display buffer.
        let text: String = text
            .chars()
            .filter_map(|c| match c {
                '\n' | '\r' | '\t' => Some(' '),
                c if c.is_control() => None,
                c => Some(c),
            })
            .take(16_384usize.saturating_sub(self.text.chars().count()))
            .collect();
        self.text.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }

    fn backspace(&mut self) {
        let previous = self.previous();
        self.text.drain(previous..self.cursor);
        self.cursor = previous;
    }

    fn delete(&mut self) {
        self.text.drain(self.cursor..self.next());
    }

    fn accept(&mut self) {
        if !self.text.trim().is_empty() && self.history.last() != Some(&self.text) {
            self.history.push(self.text.clone());
            if self.history.len() > 100 {
                self.history.remove(0);
            }
        }
        self.set(String::new());
        self.history_index = None;
        self.saved_draft.clear();
    }

    fn history(&mut self, older: bool) {
        if self.history.is_empty() {
            return;
        }
        let next = if older {
            match self.history_index {
                Some(i) => Some(i.saturating_sub(1)),
                None => {
                    self.saved_draft = self.text.clone();
                    Some(self.history.len() - 1)
                }
            }
        } else {
            match self.history_index {
                Some(i) if i + 1 < self.history.len() => Some(i + 1),
                Some(_) => None,
                None => return,
            }
        };
        self.history_index = next;
        self.set(next.map_or_else(|| self.saved_draft.clone(), |i| self.history[i].clone()));
    }
}

#[derive(Default)]
struct View {
    editor: Editor,
    menu_index: usize,
    menu_dismissed: bool,
    files_open: bool,
    file_index: usize,
    file_scroll: u16,
    // None follows the live tail. A fixed top row stays anchored while the
    // host appends text, rather than scrolling the whole terminal surface.
    transcript_scroll: Option<u16>,
    transcript_max_scroll: u16,
    transcript_area: Rect,
    files_area: Rect,
    menu_area: Rect,
    notice: String,
}

impl View {
    fn scroll_transcript(&mut self, delta: i16) {
        let top = self.transcript_scroll.unwrap_or(self.transcript_max_scroll);
        let next = top
            .saturating_add_signed(delta)
            .min(self.transcript_max_scroll);
        self.transcript_scroll = (next < self.transcript_max_scroll).then_some(next);
    }

    fn menu_open(&self) -> bool {
        self.editor.text.starts_with('/') && !self.menu_dismissed
    }

    fn event(&mut self, event: Event, file_count: usize) -> Option<Action> {
        let key = match event {
            Event::Mouse(mouse) => {
                let delta: i16 = match mouse.kind {
                    MouseEventKind::ScrollUp => -3,
                    MouseEventKind::ScrollDown => 3,
                    _ => return None,
                };
                let position = (mouse.column, mouse.row).into();
                if self.menu_open() && self.menu_area.contains(position) {
                    let count = commands::matching(&self.editor.text).len();
                    self.menu_index = self
                        .menu_index
                        .saturating_add_signed(delta.signum() as isize)
                        .min(count.saturating_sub(1));
                } else if self.files_area.contains(position) {
                    self.file_scroll = self.file_scroll.saturating_add_signed(delta);
                } else if self.transcript_area.contains(position) {
                    self.scroll_transcript(delta);
                }
                return None;
            }
            Event::Paste(text) => {
                self.editor.insert(&text);
                self.menu_dismissed = false;
                self.menu_index = 0;
                return None;
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => key,
            _ => return None,
        };
        let menu = self.menu_open();
        let matches = commands::matching(&self.editor.text);
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Char('d') if control && self.editor.text.is_empty() => {
                return Some(Action::Exit)
            }
            KeyCode::Char('c') if control => {
                if self.editor.text.is_empty() {
                    return Some(Action::Exit);
                }
                self.editor.set(String::new());
                self.menu_dismissed = false;
            }
            KeyCode::Char('f') if control => self.files_open = !self.files_open,
            KeyCode::Char('a') if control => self.editor.cursor = 0,
            KeyCode::Char('e') if control => self.editor.cursor = self.editor.text.len(),
            KeyCode::Char('u') if control => {
                self.editor.text.drain(..self.editor.cursor);
                self.editor.cursor = 0;
            }
            KeyCode::Char('w') if control => {
                while self.editor.cursor > 0
                    && self.editor.text[..self.editor.cursor].ends_with(char::is_whitespace)
                {
                    self.editor.backspace();
                }
                while self.editor.cursor > 0
                    && !self.editor.text[..self.editor.cursor].ends_with(char::is_whitespace)
                {
                    self.editor.backspace();
                }
            }
            KeyCode::Enter => {
                if menu && !matches.is_empty() {
                    return Some(Action::Submit(
                        matches[self.menu_index.min(matches.len() - 1)]
                            .name
                            .to_owned(),
                    ));
                }
                if !self.editor.text.trim().is_empty() {
                    return Some(Action::Submit(self.editor.text.trim().to_owned()));
                }
            }
            KeyCode::Esc => {
                self.menu_dismissed = true;
                self.notice.clear();
            }
            KeyCode::Up if menu => self.menu_index = self.menu_index.saturating_sub(1),
            KeyCode::Down if menu => {
                self.menu_index = (self.menu_index + 1).min(matches.len().saturating_sub(1))
            }
            KeyCode::Tab if menu => {
                if let Some(item) = matches.get(self.menu_index) {
                    self.editor.set(item.name.to_owned());
                }
                self.menu_index = 0;
            }
            KeyCode::Tab | KeyCode::BackTab
                if self.files_open && self.editor.text.is_empty() && file_count > 0 =>
            {
                self.file_index = if key.code == KeyCode::BackTab {
                    (self.file_index + file_count - 1) % file_count
                } else {
                    (self.file_index + 1) % file_count
                };
                self.file_scroll = 0;
            }
            KeyCode::PageUp | KeyCode::PageDown => {
                let delta = if key.code == KeyCode::PageUp { -8 } else { 8 };
                if key.modifiers.contains(KeyModifiers::ALT) && self.files_area.height > 0 {
                    self.file_scroll = self.file_scroll.saturating_add_signed(delta);
                } else {
                    self.scroll_transcript(delta);
                }
            }
            KeyCode::End if control => self.transcript_scroll = None,
            KeyCode::Up => self.editor.history(true),
            KeyCode::Down => self.editor.history(false),
            KeyCode::Left => self.editor.cursor = self.editor.previous(),
            KeyCode::Right => self.editor.cursor = self.editor.next(),
            KeyCode::Home => self.editor.cursor = 0,
            KeyCode::End => self.editor.cursor = self.editor.text.len(),
            KeyCode::Backspace => {
                self.editor.backspace();
                self.menu_index = 0;
                self.menu_dismissed = false;
            }
            KeyCode::Delete => self.editor.delete(),
            KeyCode::Char(c) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.editor.insert(&c.to_string());
                self.menu_index = 0;
                self.menu_dismissed = false;
            }
            _ => {}
        }
        None
    }

    fn draw(
        &mut self,
        frame: &mut Frame,
        state: Option<&ThreadState>,
        connection: &str,
        pending: bool,
        url: &str,
    ) {
        let area = frame.area();
        frame.render_widget(
            Block::default().style(Style::default().bg(BG).fg(TEXT)),
            area,
        );
        let width = area.width.saturating_sub(4).min(110);
        let area = Rect::new(
            area.x + (area.width - width) / 2,
            area.y,
            width,
            area.height,
        );
        // Keep an editable prompt even when a terminal pane is temporarily
        // collapsed during a resize.
        if area.height < 8 || area.width < 20 {
            self.transcript_area = Rect::default();
            self.files_area = Rect::default();
            self.menu_area = Rect::default();
            if area.height > 0 && area.width > 0 {
                let input = Rect::new(area.x, area.bottom() - 1, area.width, 1);
                frame.render_widget(Paragraph::new(format!("❯ {}", self.editor.text)), input);
                frame.set_cursor_position((
                    input.x
                        + (2 + self.editor.text[..self.editor.cursor].width() as u16)
                            .min(input.width - 1),
                    input.y,
                ));
            }
            return;
        }
        let menu = self.menu_open();
        let matches = commands::matching(&self.editor.text);
        let menu_height = if menu {
            (matches.len().max(1) as u16 + 2).min(area.height.saturating_sub(10))
        } else {
            0
        };
        let files_height = if self.files_open && area.height >= 25 && !menu {
            (area.height / 3).min(12)
        } else {
            0
        };
        let notice_height = if self.notice.is_empty() { 0 } else { 2 };
        let regions = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(files_height),
            Constraint::Length(menu_height),
            Constraint::Length(notice_height),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);
        self.transcript_area = regions[1];
        self.files_area = regions[2];
        self.menu_area = regions[3];
        let running = pending || state.is_some_and(|state| state.status == "running");
        let status = if connection != "connected" {
            connection
        } else if running {
            "working…"
        } else {
            "ready"
        };
        let runs = state.map_or(0, |state| state.runs);
        let clients = state.map_or(0, |state| state.clients.len());
        let header = vec![
            Line::from(vec![
                Span::styled(
                    "tress",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  v{}  ·  shared thread", env!("CARGO_PKG_VERSION")),
                    Style::default().fg(MUTED),
                ),
            ]),
            Line::from(Span::styled(
                format!(
                    "{url}  ·  {status}  ·  {runs} {}  ·  {clients} {}",
                    if runs == 1 { "run" } else { "runs" },
                    if clients == 1 { "client" } else { "clients" }
                ),
                Style::default().fg(MUTED),
            )),
        ];
        frame.render_widget(
            Paragraph::new(header).block(
                Block::default()
                    .borders(Borders::BOTTOM)
                    .border_style(Style::default().fg(BORDER)),
            ),
            regions[0],
        );

        let mut lines = vec![Line::raw("")];
        match state {
            None => lines.push(Line::styled(
                "Connecting to the host…  /help for commands",
                Style::default().fg(MUTED),
            )),
            Some(state) if state.entries.is_empty() => {
                lines.push(Line::from(vec![
                    Span::styled("tress", Style::default().fg(ACCENT)),
                    Span::styled("  /help for commands", Style::default().fg(MUTED)),
                ]));
                lines.push(Line::raw(""));
                lines.push(Line::styled(
                    "Send a prompt here or in your browser.",
                    Style::default().fg(MUTED),
                ));
                lines.push(Line::styled(
                    "Both clients follow the same conversation and files.",
                    Style::default().fg(MUTED),
                ));
                lines.push(Line::raw(""));
                lines.push(Line::styled(
                    "try  /files   /status   /attach",
                    Style::default().fg(MUTED),
                ));
            }
            Some(state) => {
                for entry in &state.entries {
                    let mut text = entry.text.lines();
                    if entry.role == "user" {
                        lines.push(Line::from(vec![
                            Span::styled("❯ ", Style::default().fg(ACCENT)),
                            Span::raw(safe(text.next().unwrap_or(""))),
                        ]));
                    } else {
                        lines.push(Line::styled(
                            if entry.error {
                                "tress · failed"
                            } else {
                                "tress"
                            },
                            Style::default().fg(ACCENT),
                        ));
                        for tool in &entry.tools {
                            lines.push(Line::styled(
                                format!("  · {}", safe(tool)),
                                Style::default().fg(MUTED),
                            ));
                        }
                    }
                    lines.extend(text.map(|line| Line::raw(safe(line))));
                    lines.push(Line::raw(""));
                }
            }
        }
        if running {
            lines.push(Line::styled("· working…", Style::default().fg(MUTED)));
        }
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        let max_scroll = paragraph
            .line_count(regions[1].width)
            .saturating_sub(regions[1].height as usize)
            .min(u16::MAX as usize) as u16;
        self.transcript_max_scroll = max_scroll;
        let top = self.transcript_scroll.unwrap_or(max_scroll).min(max_scroll);
        self.transcript_scroll = (top < max_scroll).then_some(top);
        frame.render_widget(paragraph.scroll((top, 0)), regions[1]);

        if files_height > 0 {
            self.draw_files(frame, regions[2], state);
        }
        if menu_height > 0 {
            self.menu_index = self.menu_index.min(matches.len().saturating_sub(1));
            let items: Vec<ListItem> = if matches.is_empty() {
                vec![ListItem::new("  No matching commands. Esc to close.")
                    .style(Style::default().fg(MUTED))]
            } else {
                matches
                    .iter()
                    .map(|item| {
                        ListItem::new(Line::from(vec![
                            Span::styled(format!("{:<13}", item.name), Style::default().fg(TEXT)),
                            Span::styled(item.description, Style::default().fg(MUTED)),
                        ]))
                    })
                    .collect()
            };
            let list = List::new(items)
                .block(
                    Block::default()
                        .title(" Commands · ↑↓ select · enter run · esc close ")
                        .borders(Borders::TOP | Borders::BOTTOM)
                        .border_style(Style::default().fg(BORDER)),
                )
                .highlight_symbol("› ")
                .highlight_style(Style::default().bg(Color::Rgb(24, 24, 24)));
            frame.render_stateful_widget(
                list,
                regions[3],
                &mut ListState::default()
                    .with_selected((!matches.is_empty()).then_some(self.menu_index)),
            );
        }
        frame.render_widget(
            Paragraph::new(safe(&self.notice))
                .style(Style::default().fg(MUTED))
                .wrap(Wrap { trim: false }),
            regions[4],
        );

        let composer = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(Style::default().fg(BORDER));
        let input_area = composer.inner(regions[5]);
        frame.render_widget(composer, regions[5]);
        if input_area.width > 3 && input_area.height > 0 {
            let available = input_area.width.saturating_sub(3) as usize;
            let cursor_width = self.editor.text[..self.editor.cursor].width();
            let skip = cursor_width.saturating_sub(available.saturating_sub(1));
            let mut skipped = 0;
            let visible: String = self
                .editor
                .text
                .graphemes(true)
                .skip_while(|g| {
                    if skipped < skip {
                        skipped += g.width();
                        true
                    } else {
                        false
                    }
                })
                .collect();
            let content = if self.editor.text.is_empty() {
                Span::styled(
                    if running {
                        "Working… you can draft your next prompt"
                    } else {
                        "Ask anything… or / for commands"
                    },
                    Style::default().fg(MUTED),
                )
            } else {
                Span::raw(visible)
            };
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("❯ ", Style::default().fg(ACCENT)),
                    content,
                ])),
                input_area,
            );
            frame.set_cursor_position((
                input_area.x + 2 + cursor_width.saturating_sub(skipped).min(available) as u16,
                input_area.y,
            ));
        }
        let hint = if self.transcript_scroll.is_some() {
            "history · pgdn or ctrl-end to follow live"
        } else if menu {
            "tab complete · esc close"
        } else if self.files_open {
            "tab next file · alt+pgup/pgdn files · ctrl-f hide"
        } else {
            "/ commands · ctrl-f files · pgup/pgdn history · drag to select · ctrl-d leave"
        };
        frame.render_widget(
            Paragraph::new(format!("{status}  ·  {hint}")).style(Style::default().fg(MUTED)),
            regions[6],
        );
    }

    fn draw_files(&mut self, frame: &mut Frame, area: Rect, state: Option<&ThreadState>) {
        let files: Vec<_> = state
            .into_iter()
            .flat_map(|state| state.files.iter())
            .collect();
        self.file_index = self.file_index.min(files.len().saturating_sub(1));
        let Some((name, content)) = files.get(self.file_index) else {
            frame.render_widget(
                Paragraph::new("No file previews shared by this host.")
                    .style(Style::default().fg(MUTED))
                    .block(
                        Block::default()
                            .title(" Files ")
                            .borders(Borders::TOP)
                            .border_style(Style::default().fg(BORDER)),
                    ),
                area,
            );
            return;
        };
        let block = Block::default()
            .title(format!(
                " {}  ·  {}/{}  ·  tab next file ",
                safe(name),
                self.file_index + 1,
                files.len()
            ))
            .borders(Borders::TOP)
            .border_style(Style::default().fg(BORDER));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let lines: Vec<_> = content
            .lines()
            .enumerate()
            .map(|(i, line)| {
                Line::from(vec![
                    Span::styled(format!("{:>3}  ", i + 1), Style::default().fg(MUTED)),
                    Span::raw(safe(line)),
                ])
            })
            .collect();
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        self.file_scroll = self.file_scroll.min(
            paragraph
                .line_count(inner.width)
                .saturating_sub(inner.height as usize)
                .min(u16::MAX as usize) as u16,
        );
        frame.render_widget(paragraph.scroll((self.file_scroll, 0)), inner);
    }
}

// Model output and file previews are data, never terminal control sequences.
fn safe(text: &str) -> String {
    text.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control())
        .collect()
}

pub struct Screen {
    terminal: DefaultTerminal,
    view: View,
}

impl Screen {
    pub fn new() -> io::Result<Self> {
        let terminal = ratatui::init();
        let mut screen = Self {
            terminal,
            view: View::default(),
        };
        // Mouse reporting intercepts drag gestures and prevents normal
        // terminal text selection, so scrolling stays keyboard-driven.
        crossterm::execute!(io::stdout(), EnableBracketedPaste)?;
        // Reset the full viewport without a cursor-position query (some
        // embedded terminals do not answer those queries).
        let area = screen.terminal.size()?.into();
        screen.terminal.resize(area)?;
        Ok(screen)
    }

    pub fn event(&mut self, event: Event, file_count: usize) -> io::Result<Option<Action>> {
        if let Event::Resize(width, height) = event {
            self.terminal.resize(Rect::new(0, 0, width, height))?;
        }
        Ok(self.view.event(event, file_count))
    }
    pub fn accept(&mut self) {
        self.view.editor.accept();
        self.view.menu_dismissed = false;
        self.view.menu_index = 0;
        self.view.transcript_scroll = None;
    }
    pub fn notice(&mut self, message: &str) {
        self.view.notice = message.to_owned();
    }
    pub fn help(&mut self) {
        self.view.editor.set("/".to_owned());
        self.view.menu_dismissed = false;
        self.view.menu_index = 0;
    }
    pub fn files(&mut self) {
        self.view.files_open = !self.view.files_open;
    }
    pub fn draw(
        &mut self,
        state: Option<&ThreadState>,
        connection: &str,
        pending: bool,
        url: &str,
    ) -> io::Result<()> {
        self.terminal
            .draw(|frame| self.view.draw(frame, state, connection, pending, url))?;
        Ok(())
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let _ = crossterm::execute!(io::stdout(), DisableBracketedPaste);
        ratatui::restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, MouseEvent};
    use ratatui::{backend::TestBackend, Terminal};

    fn press(view: &mut View, code: KeyCode) -> Option<Action> {
        view.event(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)), 2)
    }

    fn screen(view: &mut View, state: &ThreadState, width: u16, height: u16) -> String {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal
            .draw(|frame| {
                view.draw(
                    frame,
                    Some(state),
                    "connected",
                    false,
                    "http://localhost:5311",
                )
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content
            .chunks(width as usize)
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn reply_completion_keeps_a_prompt_and_the_draft() {
        let mut view = View::default();
        view.editor.insert("follow-up draft");
        let mut state = ThreadState {
            status: "running".into(),
            ..Default::default()
        };
        assert!(screen(&mut view, &state, 90, 28).contains("working…"));
        state.status = "idle".into();
        let output = screen(&mut view, &state, 90, 28);
        assert!(output.contains("ready"));
        assert!(output.contains("❯ follow-up draft"));
        assert_eq!(view.editor.text, "follow-up draft");
    }

    #[test]
    fn slash_menu_filters_completes_selects_and_closes() {
        let mut view = View::default();
        view.editor.insert("/re");
        press(&mut view, KeyCode::Tab);
        assert_eq!(view.editor.text, "/reconnect");
        assert!(
            matches!(press(&mut view, KeyCode::Enter), Some(Action::Submit(s)) if s == "/reconnect")
        );
        view.editor.set("/".into());
        press(&mut view, KeyCode::Down);
        assert!(
            matches!(press(&mut view, KeyCode::Enter), Some(Action::Submit(s)) if s == "/files")
        );
        press(&mut view, KeyCode::Esc);
        assert!(!view.menu_open());
        view.editor.set("/unknown".into());
        assert!(
            matches!(press(&mut view, KeyCode::Enter), Some(Action::Submit(s)) if s == "/unknown")
        );
    }

    #[test]
    fn unicode_editing_and_paste_do_not_submit_commands() {
        let mut view = View::default();
        assert!(view
            .event(Event::Paste("hi\n/clear\x1b".into()), 0)
            .is_none());
        assert_eq!(view.editor.text, "hi /clear");
        view.editor.set("a👩‍💻é".into());
        press(&mut view, KeyCode::Backspace);
        press(&mut view, KeyCode::Backspace);
        assert_eq!(view.editor.text, "a");
        view.editor.accept();
        view.editor.insert("new draft");
        press(&mut view, KeyCode::Up);
        assert_eq!(view.editor.text, "a");
        press(&mut view, KeyCode::Down);
        assert_eq!(view.editor.text, "new draft");
    }

    #[test]
    fn narrow_resizes_preserve_input_with_menu_and_files() {
        let mut view = View {
            files_open: true,
            ..Default::default()
        };
        view.editor.insert("/");
        let state = ThreadState {
            status: "idle".into(),
            files: [("notes.md".into(), "# Notes".into())].into(),
            ..Default::default()
        };
        for (width, height) in [(100, 35), (42, 16), (24, 10), (8, 4)] {
            let output = screen(&mut view, &state, width, height);
            assert!(output.contains('❯'), "missing composer at {width}×{height}");
        }
    }

    fn wheel(view: &mut View, kind: MouseEventKind, area: Rect) {
        view.event(
            Event::Mouse(MouseEvent {
                kind,
                column: area.x + 1,
                row: area.y + 1,
                modifiers: KeyModifiers::NONE,
            }),
            1,
        );
    }

    #[test]
    fn wheel_scroll_keeps_the_input_fixed_and_anchors_history_during_streaming() {
        let mut view = View::default();
        view.editor.insert("keep my draft");
        let mut state = ThreadState {
            status: "running".into(),
            entries: vec![super::super::Entry {
                id: "reply".into(),
                role: "agent".into(),
                text: (0..80).map(|i| format!("Reply line {i}\n")).collect(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let before = screen(&mut view, &state, 90, 28);
        let composer = before
            .lines()
            .position(|line| line.contains("❯ keep my draft"))
            .unwrap();
        let area = view.transcript_area;
        wheel(&mut view, MouseEventKind::ScrollUp, area);
        let after = screen(&mut view, &state, 90, 28);
        assert_eq!(
            after
                .lines()
                .position(|line| line.contains("❯ keep my draft")),
            Some(composer)
        );
        assert_ne!(before, after);
        let anchor = view.transcript_scroll.unwrap();
        state.entries[0].text.push_str("More streamed text\n");
        screen(&mut view, &state, 90, 28);
        assert_eq!(view.transcript_scroll, Some(anchor));
        for _ in 0..100 {
            wheel(&mut view, MouseEventKind::ScrollDown, area);
        }
        assert_eq!(view.transcript_scroll, None);
        assert_eq!(view.editor.text, "keep my draft");
    }

    #[test]
    fn wheel_routes_to_the_hovered_panel() {
        let mut view = View {
            files_open: true,
            ..Default::default()
        };
        let state = ThreadState {
            files: [("notes.md".into(), "A note\n".repeat(80))].into(),
            ..Default::default()
        };
        screen(&mut view, &state, 90, 32);
        let files = view.files_area;
        wheel(&mut view, MouseEventKind::ScrollDown, files);
        assert_eq!(view.file_scroll, 3);
        assert_eq!(view.transcript_scroll, None);
        view.editor.insert("/");
        screen(&mut view, &state, 90, 32);
        let menu = view.menu_area;
        wheel(&mut view, MouseEventKind::ScrollDown, menu);
        assert_eq!(view.menu_index, 1);
        assert_eq!(view.editor.text, "/");
    }
}
