//! Reading and writing `.env` files (`NAME=value` lines), for importing and exporting keys.
//!
//! Nothing here fails and nothing prints: a line [`parse`] cannot read is reported by its number
//! alone, and `Debug` on the results shows counts and line numbers, never a name or a value. Every
//! buffer that holds a value is [`Zeroizing`], the ones in between included.

use crate::item::check_key_name;
use std::fmt;
use zeroize::Zeroizing;

/// One `NAME=value` read from a file. `Debug` shows neither the name nor the value.
pub struct EnvEntry {
    pub name: String,
    pub value: Zeroizing<String>,
}

/// What [`parse`] read: the entries in the file's order (a name given twice appears twice), and
/// the numbers of the lines it could not read. `Debug` shows only the number of entries and the
/// bad line numbers.
pub struct EnvParse {
    pub entries: Vec<EnvEntry>,
    pub bad_lines: Vec<u32>,
}

impl fmt::Debug for EnvEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EnvEntry(..)")
    }
}

impl fmt::Debug for EnvParse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EnvParse")
            .field("entries", &self.entries.len())
            .field("bad_lines", &self.bad_lines)
            .finish()
    }
}

/// Spaces and tabs: what may surround a name, an `=` and a value.
const BLANKS: [char; 2] = [' ', '\t'];

/// Characters besides letters and digits that a written value may hold and still go unquoted.
const BARE_EXTRA: &str = "_-./:@+=,";

/// Reads `.env` text. It never fails and never prints: a line it cannot read is only a number in
/// `bad_lines`, counted from 1 (a value that runs over several lines counts at the line it starts
/// on). Reading goes on after a bad line.
///
/// The rules: `NAME=value` per line, with an optional `export ` in front and spaces or tabs around
/// the name and the `=`. Blank lines and `#` comments are skipped, and so is a byte-order mark at
/// the start. A value is bare (trimmed, ending at a space or tab followed by `#`), in single quotes
/// (taken literally, on one line), or in double quotes (may run over several lines and understands
/// `\\`, `\"`, `\n`, `\r`, `\t` and `\$`; any other backslash stays as it is). After a closing quote
/// only blanks or a `#` comment may follow. Nothing is interpolated. A name is valid when
/// [`check_key_name`] accepts it. A line break inside double quotes reads as `\n`, in a file with
/// LF or CRLF ends. A quote that never closes makes the line it opened on a bad line.
pub fn parse(text: &str) -> EnvParse {
    let mut parsed = EnvParse {
        entries: Vec::new(),
        bad_lines: Vec::new(),
    };
    let mut rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut number: u32 = 0;
    while !rest.is_empty() {
        number = number.saturating_add(1);
        let (line, after) = split_line(rest);
        rest = after;
        match read_line(line, after) {
            Read::Skip => {}
            Read::Bad => parsed.bad_lines.push(number),
            Read::Entry {
                entry,
                rest: next,
                extra_lines,
            } => {
                parsed.entries.push(entry);
                rest = next;
                number = number.saturating_add(extra_lines);
            }
        }
    }
    parsed
}

/// Writes entries as `NAME=value` lines, each ending in `\n`, so that [`parse`] reads back exactly
/// the same names and values. A value of only letters, digits and `_-./:@+=,` is written bare;
/// otherwise in single quotes, unless it holds a single quote or a line break, and then in double
/// quotes with `\\`, `\"`, `\n`, `\r`, `\t` and `\$` escaped.
///
/// The names are trusted: the caller passes names that were already checked with
/// [`check_key_name`] (the titles of key items). A name that is not valid is written as it is and
/// would read back as a bad line.
pub fn write(entries: &[(&str, &str)]) -> Zeroizing<String> {
    // The largest it can be, so the buffer never grows and leaves a copy of a value behind: a
    // value at most doubles in double quotes, and each line adds `=`, two quotes and a line end.
    let size = entries.iter().fold(0usize, |size, (name, value)| {
        size.saturating_add(name.len())
            .saturating_add(value.len().saturating_mul(2))
            .saturating_add(4)
    });
    let mut out = Zeroizing::new(String::with_capacity(size));
    for (name, value) in entries {
        out.push_str(name);
        out.push('=');
        push_value(&mut out, value);
        out.push('\n');
    }
    out
}

fn push_value(out: &mut String, value: &str) {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || BARE_EXTRA.contains(c))
    {
        out.push_str(value);
    } else if !value.contains(['\'', '\n', '\r']) {
        out.push('\'');
        out.push_str(value);
        out.push('\'');
    } else {
        out.push('"');
        for c in value.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '"' => out.push_str("\\\""),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '$' => out.push_str("\\$"),
                other => out.push(other),
            }
        }
        out.push('"');
    }
}

/// What one line (with any lines a double-quoted value runs over) came to.
enum Read<'a> {
    Skip,
    Bad,
    Entry {
        entry: EnvEntry,
        /// The text after the last line the entry used.
        rest: &'a str,
        /// How many lines it used beyond its first.
        extra_lines: u32,
    },
}

/// The first line of `text` without its line end (`\n` or `\r\n`), and the text after it.
fn split_line(text: &str) -> (&str, &str) {
    let (line, rest) = text.split_once('\n').unwrap_or((text, ""));
    (line.strip_suffix('\r').unwrap_or(line), rest)
}

/// `line` is one line; `after` is the text following it, for a double-quoted value that goes on.
fn read_line<'a>(line: &'a str, after: &'a str) -> Read<'a> {
    let line = line.trim_start_matches(BLANKS);
    if line.is_empty() || line.starts_with('#') {
        return Read::Skip;
    }
    let Some((name, value)) = skip_export(line).split_once('=') else {
        return Read::Bad;
    };
    let name = name.trim_end_matches(BLANKS);
    if check_key_name(name).is_err() {
        return Read::Bad;
    }
    let one_line = |value: Zeroizing<String>| Read::Entry {
        entry: EnvEntry {
            name: name.to_owned(),
            value,
        },
        rest: after,
        extra_lines: 0,
    };

    let quoted = value.trim_start_matches(BLANKS);
    if let Some(body) = quoted.strip_prefix('\'') {
        return match body.split_once('\'') {
            Some((inside, tail)) if tail_is_clear(tail) => {
                one_line(Zeroizing::new(inside.to_owned()))
            }
            _ => Read::Bad,
        };
    }
    if let Some(body) = quoted.strip_prefix('"') {
        // First pass only measures, so the value is built in a buffer of exactly its size.
        let mut size = 0usize;
        let Some(closed) = scan_double(body, after, |c| size += c.len_utf8()) else {
            return Read::Bad;
        };
        if !tail_is_clear(closed.tail) {
            return Read::Bad;
        }
        let mut text = Zeroizing::new(String::with_capacity(size));
        let _ = scan_double(body, after, |c| text.push(c));
        return Read::Entry {
            entry: EnvEntry {
                name: name.to_owned(),
                value: text,
            },
            rest: closed.rest,
            extra_lines: closed.extra_lines,
        };
    }
    one_line(Zeroizing::new(bare_value(value).to_owned()))
}

/// `line` without a leading `export` and the blanks after it. `export` is the name itself when an
/// `=` follows it, as in `export=1` or `export = 1`.
fn skip_export(line: &str) -> &str {
    let Some(after) = line.strip_prefix("export") else {
        return line;
    };
    if !after.starts_with(BLANKS) {
        return line;
    }
    let named = after.trim_start_matches(BLANKS);
    if named.starts_with('=') { line } else { named }
}

/// Nothing but blanks, or a comment, is left after a closing quote.
fn tail_is_clear(tail: &str) -> bool {
    let tail = tail.trim_start_matches(BLANKS);
    tail.is_empty() || tail.starts_with('#')
}

/// The text of a bare value (`value` is everything after the `=`): it ends at a space or tab
/// followed by `#`, and is trimmed.
fn bare_value(value: &str) -> &str {
    let mut chars = value.char_indices().peekable();
    let mut end = value.len();
    while let Some((at, c)) = chars.next() {
        if BLANKS.contains(&c) && chars.peek().is_some_and(|&(_, next)| next == '#') {
            end = at;
            break;
        }
    }
    value.split_at(end).0.trim_matches(BLANKS)
}

/// Where a double-quoted value closed.
struct Closed<'a> {
    /// The rest of the line after the closing quote.
    tail: &'a str,
    /// The text after that line.
    rest: &'a str,
    extra_lines: u32,
}

/// Reads a double-quoted value that starts at `first` (the rest of its line, after the opening
/// quote) and goes on in `after` (the following lines), handing each character of the value to
/// `push`. `None` when the quote never closes.
fn scan_double<'a>(
    first: &'a str,
    after: &'a str,
    mut push: impl FnMut(char),
) -> Option<Closed<'a>> {
    let mut line = first;
    let mut rest = after;
    let mut extra_lines: u32 = 0;
    loop {
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    return Some(Closed {
                        tail: chars.as_str(),
                        rest,
                        extra_lines,
                    });
                }
                '\\' => {
                    let mut ahead = chars.clone();
                    match ahead.next().and_then(unescape) {
                        Some(escaped) => {
                            push(escaped);
                            chars = ahead;
                        }
                        // Not an escape the rules list: the backslash stays, and so does what follows.
                        None => push('\\'),
                    }
                }
                other => push(other),
            }
        }
        if rest.is_empty() {
            return None;
        }
        push('\n');
        extra_lines = extra_lines.saturating_add(1);
        (line, rest) = split_line(rest);
    }
}

fn unescape(c: char) -> Option<char> {
    match c {
        '\\' => Some('\\'),
        '"' => Some('"'),
        'n' => Some('\n'),
        'r' => Some('\r'),
        't' => Some('\t'),
        '$' => Some('$'),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &str = include_str!("../tests/env_samples/plain.env");
    const QUOTED: &str = include_str!("../tests/env_samples/quoted.env");
    const NO_LINE_END: &str = include_str!("../tests/env_samples/no_line_end.env");

    /// Every entry as (name, value), in order.
    fn pairs(parsed: &EnvParse) -> Vec<(&str, &str)> {
        parsed
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.value.as_str()))
            .collect()
    }

    /// What `Debug` must print for a result, built from the counts and line numbers alone.
    fn fixed_debug(parsed: &EnvParse) -> String {
        format!(
            "EnvParse {{ entries: {}, bad_lines: {:?} }}",
            parsed.entries.len(),
            parsed.bad_lines
        )
    }

    #[test]
    fn invalid_name_is_a_bad_line() {
        let text = "1A=x\nA-B=x\nA B=x\n=x\nA.B=x\né=x\nLIST[0]=\nexport A B=x\n_OK1=x\n";
        let parsed = parse(text);
        assert_eq!(parsed.bad_lines, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(pairs(&parsed), [("_OK1", "x")]);
    }

    #[test]
    fn crlf_line_endings_read_the_same() {
        for sample in [PLAIN, QUOTED, NO_LINE_END] {
            assert!(
                !sample.contains('\r'),
                "the samples are committed with LF only"
            );
            let lf = parse(sample);
            let crlf_text = sample.replace('\n', "\r\n");
            let crlf = parse(&crlf_text);
            assert_eq!(pairs(&lf), pairs(&crlf));
            assert_eq!(lf.bad_lines, crlf.bad_lines);
        }
        // A multi-line quoted value reads its line break as `\n` in both.
        let lf = parse("A=\"one\ntwo\"\nB=3\n");
        let crlf = parse("A=\"one\r\ntwo\"\r\nB=3\r\n");
        assert_eq!(pairs(&lf), [("A", "one\ntwo"), ("B", "3")]);
        assert_eq!(pairs(&crlf), pairs(&lf));
        // A line end of only `\r` at the very end of the file is removed too; a lone `\r` inside stays.
        assert_eq!(pairs(&parse("A=1\r")), [("A", "1")]);
        assert_eq!(pairs(&parse("A=x\ry\n")), [("A", "x\ry")]);
    }

    #[test]
    fn bare_value_ends_at_space_hash() {
        let text =
            "A=one two # note\nB=x\t#tab\nC=#first\nD=x#y\nE= # empty\nF=  padded  \nG=\nH=a=b\n";
        let parsed = parse(text);
        assert!(parsed.bad_lines.is_empty());
        assert_eq!(
            pairs(&parsed),
            [
                ("A", "one two"),
                ("B", "x"),
                ("C", "#first"),
                ("D", "x#y"),
                ("E", ""),
                ("F", "padded"),
                ("G", ""),
                ("H", "a=b"),
            ]
        );
        // A quote that is not the first character is just text.
        assert_eq!(pairs(&parse("A=it's \"x\"\n")), [("A", "it's \"x\"")]);
    }

    #[test]
    fn single_quotes_are_literal() {
        let text = "A='a \\n $B \"q\" #x \\\\'\nB='' # c\nC = 'sp ace'  \nD='a''b'\nE='open\n";
        let parsed = parse(text);
        assert_eq!(
            pairs(&parsed),
            [("A", "a \\n $B \"q\" #x \\\\"), ("B", ""), ("C", "sp ace")]
        );
        // Text after the closing quote, and a quote that never closes: bad lines.
        assert_eq!(parsed.bad_lines, [4, 5]);
        // A single-quoted value never runs onto the next line.
        let two = parse("A='one\ntwo'\n");
        assert_eq!(two.bad_lines, [1, 2]);
        assert!(two.entries.is_empty());
    }

    #[test]
    fn double_quotes_run_over_lines_and_understand_escapes() {
        let text = "A=\"one\ntwo\n\nfour\"\nB=\"\\\\ \\\" \\n \\r \\t \\$ \\x\"\nC=\"x\" # c\nD=\"x\" y\nE=1\n";
        let parsed = parse(text);
        assert_eq!(
            pairs(&parsed),
            [
                ("A", "one\ntwo\n\nfour"),
                ("B", "\\ \" \n \r \t $ \\x"),
                ("C", "x"),
                ("E", "1"),
            ]
        );
        // The next line after a multi-line value counts its lines: `D` is line 7, bad.
        assert_eq!(parsed.bad_lines, [7]);
        // A backslash at the end of a line is not an escape: it stays, and the line break follows.
        assert_eq!(pairs(&parse("A=\"a\\\nb\"\n")), [("A", "a\\\nb")]);
        // A quote that never closes makes only its own line bad; reading goes on at the next line.
        let open = parse("A=\"open\nB=2\n");
        assert_eq!(open.bad_lines, [1]);
        assert_eq!(pairs(&open), [("B", "2")]);
        // A closing quote with junk after it: the line is bad, and the lines inside it are read on their own.
        let junk = parse("A=\"x\nB=2\nC=\"y\" z\nD=4\n");
        assert_eq!(junk.bad_lines, [1, 3]);
        assert_eq!(pairs(&junk), [("B", "2"), ("D", "4")]);
        // A quote as the last character of the file.
        assert_eq!(parse("A=\"").bad_lines, [1]);
        assert_eq!(pairs(&parse("A=\"\"")), [("A", "")]);
        assert_eq!(parse("A='").bad_lines, [1]);
    }

    #[test]
    fn dollar_is_never_interpolated() {
        let text = "A=$OTHER\nB='$OTHER'\nC=\"$OTHER ${OTHER} \\$OTHER\"\nD=${A}x\n";
        let parsed = parse(text);
        assert!(parsed.bad_lines.is_empty());
        assert_eq!(
            pairs(&parsed),
            [
                ("A", "$OTHER"),
                ("B", "$OTHER"),
                ("C", "$OTHER ${OTHER} $OTHER"),
                ("D", "${A}x"),
            ]
        );
    }

    #[test]
    fn export_prefix_is_skipped() {
        let text = "export A=1\nexport  B=2\nexport\tC=3\nexportD=4\nexport=5\nexport = 6\n  export E=7\nexport F\nexport\nexport export=8\n";
        let parsed = parse(text);
        assert_eq!(
            pairs(&parsed),
            [
                ("A", "1"),
                ("B", "2"),
                ("C", "3"),
                ("exportD", "4"),
                ("export", "5"),
                ("export", "6"),
                ("E", "7"),
                ("export", "8"),
            ]
        );
        // `export NAME` with no `=` is a bad line, as is a lone `export`.
        assert_eq!(parsed.bad_lines, [8, 9]);
    }

    #[test]
    fn comments_and_blanks_are_skipped() {
        let text = "\u{feff}# first\n\n   \n\t# indented\n#A=1\nB=2\n  # C=3\n\n";
        let parsed = parse(text);
        assert!(parsed.bad_lines.is_empty());
        assert_eq!(pairs(&parsed), [("B", "2")]);
        // Nothing at all, or only a byte-order mark, is an empty result; a mark is skipped before a name too.
        for empty in ["", "\u{feff}", "\n", "\r\n", "   "] {
            let parsed = parse(empty);
            assert!(parsed.entries.is_empty() && parsed.bad_lines.is_empty());
        }
        assert_eq!(pairs(&parse("\u{feff}A=1")), [("A", "1")]);
        // The same name twice gives two entries, in the file's order.
        assert_eq!(
            pairs(&parse("A=1\nB=2\nA=3\n")),
            [("A", "1"), ("B", "2"), ("A", "3")]
        );
    }

    #[test]
    fn bad_line_reported_by_number_only() {
        let text =
            "ok=fine\nsecret-name leaks here\nGOOD=1\nNAME='unclosed secret\nNO_EQUALS_SIGN\n";
        let parsed = parse(text);
        assert_eq!(parsed.bad_lines, [2, 4, 5]);
        assert_eq!(pairs(&parsed), [("ok", "fine"), ("GOOD", "1")]);
        // The result prints counts and numbers, never a name or a value.
        let said = format!("{parsed:?}");
        assert_eq!(said, "EnvParse { entries: 2, bad_lines: [2, 4, 5] }");
        for entry in &parsed.entries {
            assert_eq!(format!("{entry:?}"), "EnvEntry(..)");
            assert_eq!(format!("{entry:#?}"), "EnvEntry(..)");
        }
        assert!(!format!("{parsed:#?}").contains("fine"));
    }

    #[test]
    fn writer_picks_bare_then_single_then_double() {
        let written = write(&[
            ("A", ""),
            ("B", "abcXYZ019_-./:@+=,"),
            ("C", "has space"),
            ("D", "#hash"),
            ("E", "it's"),
            ("F", "two\nlines"),
            ("G", "cr\rhere"),
            ("H", "say \"hi\" $HOME \\ \t"),
            ("I", "$OTHER and `cmd`"),
            ("J", " lead and trail "),
            ("K", "é日"),
            ("L", "back\\slash 'q'"),
        ]);
        let expected = [
            "A=",
            "B=abcXYZ019_-./:@+=,",
            "C='has space'",
            "D='#hash'",
            "E=\"it's\"",
            "F=\"two\\nlines\"",
            "G=\"cr\\rhere\"",
            "H='say \"hi\" $HOME \\ \t'",
            "I='$OTHER and `cmd`'",
            "J=' lead and trail '",
            "K='é日'",
            "L=\"back\\\\slash 'q'\"",
            "",
        ]
        .join("\n");
        assert_eq!(&*written, &expected);
        // A double-quoted value escapes a quote, a backslash, a tab and a dollar sign.
        let double = write(&[("A", "it's \"x\" \\ \t $")]);
        assert_eq!(&*double, "A=\"it's \\\"x\\\" \\\\ \\t \\$\"\n");
        // No entries, no text.
        assert_eq!(&*write(&[]), "");
    }

    #[test]
    fn real_layouts_parse() {
        let plain = parse(PLAIN);
        assert_eq!(plain.bad_lines, [20, 21]);
        assert_eq!(
            pairs(&plain),
            [
                ("DATABASE_HOST", ""),
                ("DATABASE_PORT", "5432"),
                ("DATABASE_NAME", "made-up-value-0001"),
                ("SERVICE_URL", "https://example.invalid/api/v1"),
                ("SERVICE_TOKEN", "made-up-value-0003-made-up-value-0003"),
                ("SERVICE_LABEL", "Made Up Label"),
                ("SERVICE_NOTE", "made-up value"),
                ("SERVICE_PADDED", "made-up-value-0004"),
                ("SERVICE_EQUALS", "made-up-value-0005=="),
                (
                    "SERVICE_QUERY",
                    "https://example.invalid/path?mode=made-up&size=1"
                ),
                ("LAST_ONE", "made-up-value-0006"),
            ]
        );

        let quoted = parse(QUOTED);
        assert_eq!(quoted.bad_lines, [14, 16]);
        assert_eq!(
            pairs(&quoted),
            [
                ("APP_NAME", "Made Up App"),
                ("APP_MODE", "made-up-mode"),
                ("APP_SPACED", "made-up-value-0007"),
                ("APP_LITERAL", "keep $HOME and \\n as written"),
                (
                    "APP_ESCAPED",
                    "line one\nline two\ttabbed \"quoted\" back\\slash $HOME \\x"
                ),
                ("APP_COMMENT", "made-up-value-0008"),
                (
                    "APP_BLOCK",
                    "-----BEGIN MADE-UP BLOCK-----\nmade-up-line-one\nmade-up-line-two\n-----END MADE-UP BLOCK-----"
                ),
                ("APP_AFTER", "made-up-value-0009"),
                ("APP_EMPTY_QUOTES", ""),
                ("APP_NEXT", "made-up-value-0010"),
                ("APP_LAST", "$APP_NAME"),
            ]
        );

        let single = parse(NO_LINE_END);
        assert!(single.bad_lines.is_empty());
        assert_eq!(pairs(&single), [("ONLY_ONE", "made-up-value-0011")]);
    }

    mod properties {
        use super::*;
        use proptest::collection::vec;
        use proptest::prelude::*;
        use proptest::sample::select;

        const CASES: u32 = 256;

        const PIECES: &[&str] = &[
            "A", "NAME", "_x", "9", "=", " ", "\t", "\n", "\r\n", "\r", "'", "\"", "\\", "\\n",
            "\\\"", "$", "${X}", "#", " #", "export ", "export", "[", "]", "-", ".", "é", "日",
            "\u{feff}", "\u{0301}", "\0", "secret", "value", "word",
        ];

        fn odd_text() -> impl Strategy<Value = String> {
            prop_oneof![
                3 => vec(select(PIECES), 0..60).prop_map(|p| p.concat()),
                1 => vec(proptest::char::any(), 0..80).prop_map(|c| c.into_iter().collect()),
            ]
        }

        fn name() -> impl Strategy<Value = String> {
            let first: Vec<char> = ('a'..='z').chain('A'..='Z').chain(['_']).collect();
            let rest: Vec<char> = first.iter().copied().chain('0'..='9').collect();
            (select(first), vec(select(rest), 0..12)).prop_map(|(f, r)| {
                let mut s = String::from(f);
                s.extend(r);
                s
            })
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(CASES))]

            #[test]
            fn any_input_never_panics_and_never_leaks_a_value(text in odd_text()) {
                let parsed = parse(&text);
                // Fixed answers, whatever the input: the same text from the counts and numbers alone.
                prop_assert_eq!(format!("{parsed:?}"), fixed_debug(&parsed));
                for entry in &parsed.entries {
                    prop_assert_eq!(format!("{entry:?}"), "EnvEntry(..)");
                }
                // Line numbers count from 1, rise, and stay inside the text.
                let lines = u32::try_from(text.split('\n').count()).unwrap_or(u32::MAX);
                for pair in parsed.bad_lines.windows(2) {
                    prop_assert!(pair[0] < pair[1]);
                }
                prop_assert!(parsed.bad_lines.iter().all(|n| (1..=lines).contains(n)));
            }

            #[test]
            fn written_then_read_is_identical(
                list in vec((name(), odd_text()), 0..8),
            ) {
                let borrowed: Vec<(&str, &str)> =
                    list.iter().map(|(n, v)| (n.as_str(), v.as_str())).collect();
                let text = write(&borrowed);
                let parsed = parse(&text);
                prop_assert!(parsed.bad_lines.is_empty());
                prop_assert_eq!(pairs(&parsed), borrowed);
                prop_assert!(text.is_empty() || text.ends_with('\n'));
                prop_assert!(!text.contains("\r\n"));
            }
        }
    }
}
