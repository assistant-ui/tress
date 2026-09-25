//! Markdown is presentation only. The shared transcript and plain CLI stay raw.

use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use tui_markdown::{Options, StyleSheet};

use super::{safe, BORDER, MUTED, TEXT};

#[derive(Clone)]
struct Theme;

impl StyleSheet for Theme {
    fn heading(&self, _level: u8) -> Style {
        Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
    }
    fn heading_marker(&self, _level: u8) -> &str {
        ""
    }
    fn code(&self) -> Style {
        Style::default().fg(TEXT).bg(Color::Rgb(23, 23, 23))
    }
    fn code_block_fence(&self) -> &str {
        ""
    }
    fn link(&self) -> Style {
        Style::default().fg(TEXT).add_modifier(Modifier::UNDERLINED)
    }
    fn blockquote(&self) -> Style {
        Style::default().fg(MUTED)
    }
    fn metadata_block(&self) -> Style {
        Style::default().fg(MUTED)
    }
    fn math_inline(&self) -> Style {
        Style::default().fg(TEXT)
    }
    fn math_display(&self) -> Style {
        Style::default().fg(TEXT)
    }
    fn table_header(&self) -> Style {
        Style::default().fg(TEXT).add_modifier(Modifier::BOLD)
    }
    fn table_border(&self) -> Style {
        Style::default().fg(BORDER)
    }
    fn list_marker(&self) -> Style {
        Style::default().fg(MUTED)
    }
    fn alert(&self, _kind: tui_markdown::AlertKind) -> Style {
        Style::default().fg(MUTED)
    }
    fn alert_icon(&self, _kind: tui_markdown::AlertKind) -> &str {
        ""
    }
}

pub(super) fn render(source: &str, width: u16) -> Vec<Line<'static>> {
    let options = Options::new(Theme).table_width(width);
    // Preserve Markdown whitespace but never pass through terminal controls.
    let source: String = source
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    tui_markdown::from_str_with_options(&source, &options)
        .lines
        .into_iter()
        .map(|line| {
            Line::from(
                line.spans
                    .into_iter()
                    .map(|span| Span::styled(safe(&span.content.replace('\t', "    ")), span.style))
                    .collect::<Vec<_>>(),
            )
            .style(line.style)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[Line<'_>]) -> String {
        lines
            .iter()
            .map(Line::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn tool_list_renders_numbering_and_bold_without_markdown_delimiters() {
        let lines = render(
            "1. **read** – Read a UTF-8 file.\n2. **ls** – List a directory.\n3. **write** – Create a file.\n4. **edit** – Replace text.\n5. **bash** – Run a command.",
            80,
        );
        assert_eq!(lines.len(), 5);
        assert!(text(&lines).starts_with("1. read – Read a UTF-8 file."));
        assert!(text(&lines).contains("5. bash – Run a command."));
        assert!(!text(&lines).contains("**"));
        let read = lines[0]
            .spans
            .iter()
            .find(|span| span.content == "read")
            .unwrap();
        assert!(read.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn code_preserves_literal_markdown_and_indentation_while_streaming() {
        for source in [
            "```js\n  const value = '**literal**';\n",
            "```js\n  const value = '**literal**';\n```",
        ] {
            let lines = render(source, 80);
            assert_eq!(text(&lines), "  const value = '**literal**';");
            assert!(!lines[0].spans[0]
                .style
                .add_modifier
                .contains(Modifier::BOLD));
        }
        assert_eq!(
            text(&render("Use `notes.md` and *emphasis*.", 80)),
            "Use notes.md and emphasis."
        );
    }

    #[test]
    fn headings_links_quotes_tasks_and_tables_are_readable() {
        let lines = render("## Tools\n\n> A quote\n\n- [x] Done\n\n[Docs](https://example.com)\n\n| Tool | Status |\n| --- | --- |\n| read | ready |", 36);
        let output = text(&lines);
        assert!(output.starts_with("Tools\n"));
        assert!(output.contains("A quote"));
        assert!(output.contains("[x] Done"));
        assert!(output.contains("Docs (https://example.com)"));
        assert!(output.contains("│ Tool"));
        assert!(lines.iter().all(|line| line.width() <= 36));
    }

    #[test]
    fn controls_in_replies_and_links_never_reach_the_terminal() {
        let output = text(&render(
            "**safe**\u{1b}[2J\n\n[link](https://example.com/\u{1b})",
            80,
        ));
        assert!(!output.chars().any(|c| c.is_control() && c != '\n'));
    }
}
