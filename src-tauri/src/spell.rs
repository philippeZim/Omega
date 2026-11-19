//! Spell checking with `spellbook` (Hunspell-compatible, supports German compounds).
//! Dictionaries are embedded; a personal word list per language lives in the app config dir.
use spellbook::Dictionary;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Manager};

type Dict = Arc<RwLock<Dictionary>>;

#[derive(Default)]
pub struct SpellState {
    dicts: Mutex<HashMap<String, Dict>>,
}

fn sources(lang: &str) -> Option<(&'static str, &'static str)> {
    Some(match lang {
        "de" => (include_str!("../dicts/de.aff"), include_str!("../dicts/de.dic")),
        "en" => (include_str!("../dicts/en.aff"), include_str!("../dicts/en.dic")),
        "fr" => (include_str!("../dicts/fr.aff"), include_str!("../dicts/fr.dic")),
        _ => return None,
    })
}

fn personal_path(app: &AppHandle, lang: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(format!("dict.{lang}.txt")))
}

fn get(app: &AppHandle, lang: &str) -> Result<Dict, String> {
    let state = app.state::<SpellState>();
    if let Some(d) = state.dicts.lock().unwrap().get(lang) {
        return Ok(d.clone());
    }
    let (aff, dic) = sources(lang).ok_or("Unbekannte Sprache")?;
    let mut dict = Dictionary::new(aff, dic).map_err(|e| e.to_string())?;
    if let Some(words) = personal_path(app, lang).and_then(|p| std::fs::read_to_string(p).ok()) {
        for w in words.lines().filter(|w| !w.is_empty()) {
            let _ = dict.add(w);
        }
    }
    let d = Arc::new(RwLock::new(dict));
    state.dicts.lock().unwrap().insert(lang.to_string(), d.clone());
    Ok(d)
}

/// Returns the subset of `words` that is misspelled.
#[tauri::command]
pub async fn spell_check(app: AppHandle, lang: String, words: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = get(&app, &lang)?;
        let d = d.read().unwrap();
        Ok(words.into_iter().filter(|w| !d.check(w)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spell_suggest(app: AppHandle, lang: String, word: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = get(&app, &lang)?;
        let mut out = Vec::new();
        d.read().unwrap().suggest(&word, &mut out);
        out.truncate(7);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn spell_add(app: AppHandle, lang: String, word: String) -> Result<(), String> {
    let d = get(&app, &lang)?;
    d.write().unwrap().add(&word).map_err(|e| e.to_string())?;
    if let Some(p) = personal_path(&app, &lang) {
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut list = std::fs::read_to_string(&p).unwrap_or_default();
        list.push_str(&word);
        list.push('\n');
        std::fs::write(p, list).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_and_compounds() {
        for (lang, ok, bad) in [
            ("de", &["Rechtschreibprüfung", "Häuser", "Donaudampfschiff"][..], &["Tesst", "Rechtschreibprüfunng"][..]),
            ("en", &["receive", "don't"][..], &["recieve"][..]),
            ("fr", &["homme", "maison"][..], &["boujour"][..]),
        ] {
            let (aff, dic) = sources(lang).unwrap();
            let t = std::time::Instant::now();
            let d = Dictionary::new(aff, dic).unwrap();
            for w in ok { assert!(d.check(w), "{lang}: {w} should be correct"); }
            for w in bad { assert!(!d.check(w), "{lang}: {w} should be wrong"); }
            let mut s = vec![];
            d.suggest(bad[0], &mut s);
            println!("{lang} loaded in {:?}, suggestions for {}: {:?}", t.elapsed(), bad[0], &s[..s.len().min(4)]);
        }
    }
}
