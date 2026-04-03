# Summarize V.2 for SillyTavern

A drop-in upgrade to SillyTavern's built-in Summarize extension. Fixes the core problem where the original summarizer strips all jailbreaks and system prompts before generating — causing summaries that ignore your character's tone, language rules, and roleplay style.

## What's Different

The built-in summarizer uses `generateQuietPrompt()` internally, which deliberately removes all system prompts and jailbreaks before sending to the API. This extension replaces that with `generateRaw()` + Connection Profile support, so the AI summarizes using the same jailbreak/prompt setup as your actual chat.

## Features

- **Connection Profile selector** — pick which API + jailbreak to use for summarization, independent of your main chat connection
- **Output Language control** — force summaries to be written in English regardless of the chat language (useful for Thai, Chinese, Japanese users to save tokens)
- **Full UI parity** with the original Summarize extension (prompt builder, injection position, depth, role, update frequency, etc.)
- **Compatible** with `{{summary}}` and `{{cs_summary}}` macros, and stores data in the same `mes.extra.memory` field

## Installation

1. Open SillyTavern and go to the **Extensions** panel (puzzle piece icon in the top bar)
2. Click **Install extension**
3. Paste this repository's GitHub URL
4. Click **Install** — SillyTavern will download the files automatically
5. Refresh your browser tab

## Usage

After installation, a **Summarize V.2** panel will appear in the Extensions sidebar.

### Connection Profile

Select a Connection Profile to use its API and jailbreak/system prompt for summarization. If left empty, falls back to the current main API using `generateRaw()`.

> This requires the **Connection Manager** extension to be enabled. If it's disabled or no profiles exist, the dropdown is hidden automatically.

### Output Language

| Option | Behavior |
|---|---|
| Follow Jailbreak / Profile | Summary language follows whatever your jailbreak/system prompt dictates |
| Force English | Appends an English-only instruction to the summary prompt, overriding the chat language |

### Prompt Builder (when no Connection Profile selected)

| Mode | Behavior |
|---|---|
| Raw, blocking | Builds its own prompt from unsummarized messages. Blocks chat during generation. |
| Raw, non-blocking | Same as above, but doesn't block the chat UI. |
| Classic, blocking | Uses the main prompt builder with the summary request appended. |

### Slash Command

```
/csummarize
/csummarize [text to summarize]
/csummarize source=main prompt="Summarize briefly" [text]
/csummarize quiet=true
```

### Macro

Use `{{cs_summary}}` in Author's Note, World Info, or prompts to insert the latest generated summary.

> The standard `{{summary}}` macro also works if the original Summarize extension is active alongside this one (both write to the same `mes.extra.memory` field).

## Notes

- This extension stores summaries in the same location as the original (`mes.extra.memory`), so switching between the two extensions won't lose existing summaries
- The slash command is `/csummarize` (not `/summarize`) to avoid conflicting with the original extension if both are enabled
- `MODULE_NAME` is `2_custom_summarizer` so injection doesn't conflict with `1_memory`
