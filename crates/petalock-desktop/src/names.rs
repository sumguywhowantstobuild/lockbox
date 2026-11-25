//! Plan 5, Task 0c, `no_lockbox_in_what_people_see` (the shell's half; the page's half is `ui/src/names.test.ts`): the
//! product is Petalock, and no word a person or Windows is shown says Lockbox. Since Task 0e renamed the code names too,
//! no shipped string of the shell says `lockbox` (the format labels live in `petalock-core`), so [`ALLOWED`] is empty: a
//! new one fails this test until someone decides it is a code name nobody is shown and adds it there, with the reason.
//! The repository-wide scan is `scripts/names.test.mjs`.

use std::fs;
use std::path::{Path, PathBuf};

/// Every string literal in `source`, as written between its quotes (escapes are not undone, which a name search does not
/// need). Comments and character literals are skipped, so a comment may still say Lockbox and a `'"'` opens nothing.
fn string_literals(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                let mut depth = 1;
                i += 2;
                while i < chars.len() && depth > 0 {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            }
            // A raw string, `r"..."` or `r#"..."#` (with a `b` before it or not): ends at a quote and as many hashes.
            'r' if i == 0
                || !ident(chars[i - 1])
                || (chars[i - 1] == 'b' && (i < 2 || !ident(chars[i - 2]))) =>
            {
                let mut j = i + 1;
                let mut hashes = 0;
                while chars.get(j) == Some(&'#') {
                    hashes += 1;
                    j += 1;
                }
                if chars.get(j) != Some(&'"') {
                    i += 1;
                    continue;
                }
                let start = j + 1;
                let mut end = start;
                while end < chars.len()
                    && !(chars[end] == '"'
                        && (1..=hashes).all(|k| chars.get(end + k) == Some(&'#')))
                {
                    end += 1;
                }
                found.push(chars[start..end.min(chars.len())].iter().collect());
                i = end + 1 + hashes;
            }
            '"' => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end] != '"' {
                    end += if chars[end] == '\\' { 2 } else { 1 };
                }
                found.push(chars[start..end.min(chars.len())].iter().collect());
                i = end + 1;
            }
            // A character literal (`'a'`, `'\''`, `'"'`) is skipped whole; `'a` with no closing quote is a lifetime.
            '\'' => {
                if chars.get(i + 1) == Some(&'\\') {
                    // Past the backslash and the escaped character (which may be a quote, as in `'\''`).
                    i += 3;
                    while i < chars.len() && chars[i] != '\'' {
                        i += 1;
                    }
                    i += 1;
                } else if chars.get(i + 2) == Some(&'\'') {
                    i += 3;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    found
}

/// Where the item that opens with the `{` at `open` ends: just past its matching `}`, braces inside strings, character
/// literals and comments not counted. The end of the text when it never closes.
fn past_matching_brace(chars: &[char], open: usize) -> usize {
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut depth = 0usize;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                let mut nested = 1;
                i += 2;
                while i < chars.len() && nested > 0 {
                    if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                        nested += 1;
                        i += 1;
                    } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        nested -= 1;
                        i += 1;
                    }
                    i += 1;
                }
                continue;
            }
            'r' if (i == 0 || !ident(chars[i - 1]) || chars[i - 1] == 'b')
                && matches!(chars.get(i + 1), Some('"' | '#')) =>
            {
                let mut j = i + 1;
                let mut hashes = 0;
                while chars.get(j) == Some(&'#') {
                    hashes += 1;
                    j += 1;
                }
                if chars.get(j) == Some(&'"') {
                    j += 1;
                    while j < chars.len()
                        && !(chars[j] == '"'
                            && (1..=hashes).all(|k| chars.get(j + k) == Some(&'#')))
                    {
                        j += 1;
                    }
                    i = j + 1 + hashes;
                    continue;
                }
            }
            '"' => {
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    i += if chars[i] == '\\' { 2 } else { 1 };
                }
            }
            '\'' => {
                if chars.get(i + 1) == Some(&'\\') {
                    // Past the backslash and the escaped character (which may be a quote, as in `'\''`).
                    i += 3;
                    while i < chars.len() && chars[i] != '\'' {
                        i += 1;
                    }
                } else if chars.get(i + 2) == Some(&'\'') {
                    i += 2;
                }
            }
            _ => {}
        }
        i += 1;
    }
    chars.len()
}

/// The part of a source file that ships: the file without the bodies of its inline test modules (`#[cfg(test)]`, then
/// `mod name {` and its body). Only each module's own body is cut, so code after it ships and is read. A test module
/// declared in another file (`#[cfg(test)]` then `mod name;`, a comment after the semicolon or not) holds nothing here.
fn shipped_part(source: &str) -> String {
    let source = source.replace("\r\n", "\n");
    let marker = "\n#[cfg(test)]\nmod ";
    let mut shipped = String::new();
    let mut rest = source.as_str();
    while let Some(at) = rest.find(marker) {
        let line_start = at + marker.len();
        let line_end = rest[line_start..]
            .find('\n')
            .map_or(rest.len(), |n| line_start + n);
        let line = &rest[line_start..line_end];
        let code = line.find("//").map_or(line, |comment| &line[..comment]);
        // A declaration ends at its semicolon; a module with a body opens a brace.
        if code.trim_end().ends_with(';') {
            shipped.push_str(&rest[..line_end]);
            rest = &rest[line_end..];
            continue;
        }
        shipped.push_str(&rest[..at]);
        let chars: Vec<char> = rest[line_start..].chars().collect();
        let Some(open) = chars.iter().position(|&c| c == '{') else {
            return shipped;
        };
        let end = past_matching_brace(&chars, open);
        let skipped: usize = chars[..end].iter().map(|c| c.len_utf8()).sum();
        rest = &rest[line_start + skipped..];
    }
    shipped.push_str(rest);
    shipped
}

/// The source files under `dir` that ship, with their text, by path relative to `src`: the test helpers (`testing.rs`,
/// this file and the `*_tests.rs` files) are not the app.
fn shipped_sources(dir: &Path, base: &Path, into: &mut Vec<(String, String)>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            shipped_sources(&path, base, into);
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".rs")
            || name == "testing.rs"
            || name == "names.rs"
            || name.ends_with("_tests.rs")
        {
            continue;
        }
        let relative = path
            .strip_prefix(base)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        into.push((relative, shipped_part(&fs::read_to_string(&path).unwrap())));
    }
}

fn says_lockbox(text: &str) -> bool {
    text.to_ascii_lowercase().contains("lockbox")
}

/// The shipped string literals that say `lockbox`, as `(file, literal)`.
fn lockbox_literals(sources: &[(String, String)]) -> Vec<(String, String)> {
    let mut hits = Vec::new();
    for (file, text) in sources {
        for literal in string_literals(text) {
            if says_lockbox(&literal) {
                hits.push((file.clone(), literal));
            }
        }
    }
    hits
}

/// The `lockbox` strings that stay in the shell, by file, and why. None may be shown to a person or to Windows. Empty
/// since Task 0e renamed the event names, the tray's id, the guide's address and the crate.
const ALLOWED: &[(&str, &str)] = &[];

/// Everything the shell shows a person or Windows, by name: the window's title, the tray's tooltip and menu, the notice
/// that the app can't start, the file filters and default file names of the boxes, and the product and identifier in
/// `tauri.conf.json`.
fn shown_words() -> Vec<(&'static str, String)> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut words = vec![
        (
            "productName",
            config["productName"].as_str().unwrap().to_owned(),
        ),
        (
            "identifier",
            config["identifier"].as_str().unwrap().to_owned(),
        ),
        ("window title", crate::window::WINDOW_TITLE.to_owned()),
        ("tray tooltip", crate::tray::TOOLTIP.to_owned()),
        (
            "backup extension",
            crate::commands::backup::EXTENSION.to_owned(),
        ),
        (
            "backup filter name",
            crate::commands::backup::FILTER.0.to_owned(),
        ),
        (
            "export's default file name",
            crate::commands::readable::EXPORT_FALLBACK_NAME.to_owned(),
        ),
        (
            "recovery PDF's default file name",
            crate::commands::readable::RECOVERY_PDF_NAME.to_owned(),
        ),
    ];
    for extension in crate::commands::backup::FILTER.1 {
        words.push(("backup filter extension", (*extension).to_owned()));
    }
    for (_, text) in crate::tray::ITEMS {
        words.push(("tray menu", text.to_owned()));
    }
    let notice = crate::launch::CANT_START;
    for text in [notice.title, notice.text, notice.open_guide, notice.close] {
        words.push(("can't-start notice", text.to_owned()));
    }
    words
}

#[test]
fn no_lockbox_in_what_people_see() {
    // What is shown, by name.
    let words = shown_words();
    assert!(
        words.len() >= 15,
        "the list of shown words went missing: {}",
        words.len()
    );
    for (what, text) in &words {
        assert!(!says_lockbox(text), "{what} says Lockbox: {text:?}");
    }
    // The metadata the capability file ships.
    let capability = include_str!("../capabilities/main.json");
    assert!(
        !says_lockbox(capability),
        "capabilities/main.json says Lockbox"
    );

    // Every string literal of the shipped code: only the listed code names say lockbox.
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources = Vec::new();
    shipped_sources(&base, &base, &mut sources);
    assert!(
        sources.len() > 30,
        "the sources went missing: {}",
        sources.len()
    );
    let literals: usize = sources
        .iter()
        .map(|(_, text)| string_literals(text).len())
        .sum();
    println!(
        "scanned {} files, {literals} string literals",
        sources.len()
    );
    assert!(
        literals > 500,
        "the scan found too few string literals: {literals}"
    );
    let hits = lockbox_literals(&sources);
    let allowed = |hit: &(String, String)| {
        ALLOWED
            .iter()
            .any(|(file, literal)| hit.0 == *file && hit.1 == *literal)
    };
    let unlisted: Vec<_> = hits.iter().filter(|hit| !allowed(hit)).collect();
    assert!(
        unlisted.is_empty(),
        "string literals that say Lockbox: {unlisted:#?}"
    );
    // And no entry of the list has gone stale.
    for (file, literal) in ALLOWED {
        assert!(
            hits.iter().any(|hit| hit.0 == *file && hit.1 == *literal),
            "{file}: {literal:?} is listed but no longer there"
        );
    }
}

/// The scan itself: it fires on a planted word, in a plain, a raw, a byte and a multi-line literal, and a format string,
/// is quiet on a comment, a character literal and clean code, and counts what it read.
#[test]
fn the_scan_for_lockbox_fires_on_a_planted_word_and_stays_quiet_when_clean() {
    let planted = r##"
        // A comment that says Lockbox is not a word anyone is shown.
        fn shown() {
            let a = "Welcome to Lockbox";
            let b = r"raw LOCKBOX";
            let c = r#"a "quoted" lockbox"#;
            let d = b"byte Lockbox";
            let e = "line one \
                     Lockbox two";
            let f = format!("Open {}", "my lockbox");
            let quote = '"';
            let tick = '\'';
            let after = "clean";
        }
    "##;
    let sources = vec![("planted.rs".to_owned(), planted.to_owned())];
    let hits = lockbox_literals(&sources);
    assert_eq!(hits.len(), 6, "{hits:#?}");
    assert_eq!(hits[0].1, "Welcome to Lockbox");
    assert_eq!(
        string_literals(planted).len(),
        8,
        "every literal is counted"
    );

    let clean = vec![(
        "clean.rs".to_owned(),
        "fn f<'a>(x: &'a str) { let q = '\"'; let _ = \"Petalock\"; } // Lockbox in a comment\n/* \"Lockbox\" */"
            .to_owned(),
    )];
    assert!(lockbox_literals(&clean).is_empty());
    assert_eq!(string_literals(&clean[0].1), ["Petalock"]);
    // The body of an inline test module is not the app.
    assert_eq!(
        shipped_part("let a = \"x\";\n#[cfg(test)]\nmod tests { \"Lockbox\" }"),
        "let a = \"x\";"
    );
    // A test module declared in another file is no cut: the code after the declaration ships, and a planted old-name
    // literal there is found (once with the declaration before it, once with an inline module after it), and a clean file
    // with the same shape finds nothing.
    let after_declaration = "fn a() {}\n#[cfg(test)]\nmod names;\nfn shown() { let _ = \"Welcome to Lockbox\"; }\n\
                             #[cfg(test)]\nmod tests { \"Lockbox again\" }\n";
    let sources = vec![("planted.rs".to_owned(), shipped_part(after_declaration))];
    assert_eq!(
        lockbox_literals(&sources),
        [("planted.rs".to_owned(), "Welcome to Lockbox".to_owned())]
    );
    let clean_after = after_declaration.replace("Welcome to Lockbox", "Welcome to Petalock");
    assert!(lockbox_literals(&[("clean.rs".to_owned(), shipped_part(&clean_after))]).is_empty());
    assert_eq!(
        string_literals(&shipped_part(&clean_after)),
        ["Welcome to Petalock"]
    );
    // Task 0c's review: code after an inline test module ships and is read. The module's body ends at its own brace,
    // not at a brace inside a string, a comment or a character literal (each would leave its test literal behind).
    let after_inline = "fn a() {}\n#[cfg(test)]\nmod tests { let s = \"}\"; /* } */ let c = '}'; let r = r#\"}\"#; \
                        let t = \"Lockbox in a test\"; }\nfn shown() { let _ = \"Welcome to Lockbox\"; }\n";
    assert_eq!(
        lockbox_literals(&[("planted.rs".to_owned(), shipped_part(after_inline))]),
        [("planted.rs".to_owned(), "Welcome to Lockbox".to_owned())]
    );
    // An escaped quote in a character literal (`'\''`) ends the literal at its own closing quote, in both readers: read one
    // quote short, the next `','` and `'"'` would be misread and open a string that swallows the code after it.
    let tricky = "fn a() {}\n#[cfg(test)]\nmod tests { f('\\'','\"'); let t = \"Lockbox in a test\"; }\n\
                  fn shown() { f('\\'','\"'); let _ = \"Welcome to Lockbox\"; }\n";
    assert_eq!(
        lockbox_literals(&[("planted.rs".to_owned(), shipped_part(tricky))]),
        [("planted.rs".to_owned(), "Welcome to Lockbox".to_owned())]
    );
    // And a declaration with a comment after its semicolon cuts nothing.
    let commented = "fn a() {}\n#[cfg(test)]\nmod names; // the scan\nfn shown() { let _ = \"Welcome to Lockbox\"; }\n";
    assert_eq!(
        lockbox_literals(&[("planted.rs".to_owned(), shipped_part(commented))]),
        [("planted.rs".to_owned(), "Welcome to Lockbox".to_owned())]
    );
}
