## Executive Summary

Claude Code's interface is a terminal (Ink/React) TUI with no official public web-UI spec. This report reconstructs a faithful design-token system and component/interaction spec from three tiers of evidence: (1) **official Anthropic documentation** (terminal-config, keybindings, interactive-mode, permissions, statusline docs) — high confidence; (2) **the theme-override schema exposed by Claude Code itself** (`/theme` custom theme JSON, documented + reverse-engineered token names) — high confidence for token *names and roles*, lower confidence for exact *default hex values* since Anthropic does not publish the literal default RGB values in prose docs; (3) **community reverse-engineering / recreations** (tweakcc, theme gists, brand-color aggregator sites) — medium confidence, used only to fill gaps and flagged as such. Where multiple independent community sources converge on the same hex value, confidence is marked higher.

***

## 1. Design Token Sheet

### 1.1 Color palette

**Anthropic brand / marketing colors** — sourced from independent brand-color aggregators that scrape anthropic.com's CSS; these do not come from Claude Code itself but represent the corporate palette Claude Code's default accent is drawn from:[^1][^2][^3]

| Token | Hex | Role | Confidence |
|---|---|---|---|
| `--anthropic-orange` (brand accent, "clay"/"burnt orange") | `#D97757` (also seen cited as `#CC785C` / `#C96442` / `#D4A27F` across sources) | Primary accent, buttons, wordmark flame motif | Medium — sources disagree on exact hex; `#D97757` and `#CC785C` both recur [^1][^2][^3] |
| `--anthropic-cream` (background) | `#FAF9F5` (alt: `#F0EFEA` / `#F0EEE6`) | Page/app background, light mode | Medium — 2 close variants reported [^1][^2][^3] |
| `--anthropic-charcoal` (foreground) | `#141413` (alt: `#191919`) | Primary text, near-black | Medium-high — highly consistent across sources [^1][^2][^3] |
| `--anthropic-white` | `#FFFFFF` | Pure white surface (rare, brand avoids pure white/black per some style guides) | Medium [^2] |
| `--anthropic-blue` (secondary accent) | `#6A9BCC` | Secondary/decorative accent | Low-medium [^1] |
| `--anthropic-green` (secondary accent) | `#788C5D` | Secondary/decorative accent | Low-medium [^1] |

**Claude Code terminal UI tokens** — these are the *actual, documented* theme-override token names Claude Code exposes via `/theme` → custom theme JSON. Anthropic's docs name every token and describe its function precisely, but do **not** publish the literal default hex/RGB values in prose — those must be reverse-engineered from the binary. Community reverse-engineering (a gist explicitly extracted from Claude Code v2.1.126's binary strings) confirms the **token catalog** (69 tokens, 35 officially documented + 34 internal) is accurate, but the specific default color values below come from a secondary blog post cross-referencing the dark/light presets, not from Anthropic directly — treat hex values as **approximate/medium confidence**:[^4][^5]

| CSS variable | Claude Code token | Dark default (reported) | Light default (reported) | Role | Confidence |
|---|---|---|---|---|---|
| `--cc-claude` | `claude` | `rgb(215,119,87)` (~`#D77757`) | same accent, adjusted | Brand accent — spinner, assistant label | Medium [^6][^4] |
| `--cc-text` | `text` | `rgb(255,255,255)` white | `rgb(0,0,0)` black | Default foreground | Medium [^6] |
| `--cc-success` | `success` | `rgb(78,186,101)` bright green | `rgb(44,122,57)` dark green | Success/pass state | Medium [^6] |
| `--cc-error` | `error` | `rgb(255,107,128)` bright red-pink | `rgb(171,43,63)` dark red | Errors/failures | Medium [^6] |
| `--cc-warning` | `warning` | (unpublished exact value) | (unpublished) | Warnings, auto-mode border | Low — name/role confirmed, no hex found [^4] |
| `--cc-diff-added-bg` | `diffAdded` | `rgb(34,92,43)` dim green | `rgb(105,219,124)` bright green | Added-line background | Medium [^6][^7] |
| `--cc-diff-removed-bg` | `diffRemoved` | `rgb(122,41,54)` dim red | `rgb(255,168,180)` bright pink-red | Removed-line background | Medium [^6][^7] |
| `--cc-diff-added-dimmed` | `diffAddedDimmed` | darker/desaturated version of added | — | Rejected-edit dimmed diff | High (role only) [^4] |
| `--cc-diff-removed-dimmed` | `diffRemovedDimmed` | darker/desaturated version of removed | — | Rejected-edit dimmed diff | High (role only) [^4] |
| `--cc-diff-added-word` | `diffAddedWord` | brighter than `diffAdded` | — | Word-level add highlight | High (role only) [^4] |
| `--cc-diff-removed-word` | `diffRemovedWord` | brighter than `diffRemoved` | — | Word-level remove highlight | High (role only) [^4] |
| `--cc-inactive` | `inactive` | muted gray | muted gray | Hints, timestamps, disabled | High (role) [^4] |
| `--cc-subtle` | `subtle` | very faint gray | very faint gray | Faint borders, de-emphasized text | High (role) [^4] |
| `--cc-permission` | `permission` | teal/gold accent | — | Permission dialog border | High (role only) [^4] |
| `--cc-plan-mode` | `planMode` | blue/cyan accent | — | Plan-mode accent and border | High (role only) [^4] |
| `--cc-auto-accept` | `autoAccept` | green/lime accent | — | Accept-edits mode accent/border | High (role only) [^4] |
| `--cc-bash-border` | `bashBorder` | orange/red accent | — | Border when typing `!` shell command | High (role only) [^4] |
| `--cc-prompt-border` | `promptBorder` | neutral gray | — | Default input-box border (Manual mode) | High (role only) [^4] |
| `--cc-user-msg-bg` | `userMessageBackground` | dark tinted panel | light tinted panel | Background behind user turns (fullscreen renderer) | High (role) [^4] |
| `--cc-selection-bg` | `selectionBg` | highlighted blue-gray | — | Mouse text-selection background | High (role) [^4] |
| `--cc-rate-limit-fill` / `-empty` | `rate_limit_fill` / `rate_limit_empty` | accent / gray | — | `/usage` meter bar | High (role) [^4] |
| `--cc-subagent-{red,blue,green,yellow,purple,orange,pink,cyan}` | `lor>_FOR_SUBAGENTS_ONLY` | standard ANSI-adjacent hues | — | Distinguishing parallel subagents in transcript | High (role) [^4] |

**Recommendation for web port:** Since Anthropic never publishes literal hex defaults for the CLI theme and the values above are third-party approximations, build the web palette from the **documented Anthropic brand colors** (`#D97757` orange accent, `#FAF9F5`/`#141413` background/foreground pair) rather than the terminal's exact RGB — this guarantees on-brand fidelity even where terminal-internal values are uncertain.

### 1.2 Typography

Anthropic uses three custom, non-licensed typefaces confirmed by multiple independent brand-audit sites and a font-troubleshooting article on claude.ai's own font picker UI:[^8][^9][^10]

| Family | Use | Web-safe fallback stack | Confidence |
|---|---|---|---|
| Anthropic Serif | claude.ai default chat font (editorial/display headlines on marketing site) | `ui-serif, Georgia, Cambria, "Times New Roman", Times, serif` | High — fallback stack independently confirmed by two sources [^11][^9] |
| Anthropic Sans | UI chrome, navigation, body copy, accessible alternative chat font | `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` (Inter/DM Sans as closer visual match) | High [^9][^10] |
| Anthropic Mono | Code blocks, technical labels, metadata | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace` (JetBrains Mono / IBM Plex Mono as closer visual match) | High [^9] |
| Styrene A/B | Legacy marketing headline face (older anthropic.com), largely superseded by Anthropic Sans/Serif | Inter, DM Sans | Medium — some sources describe it as still in use, others as legacy [^10][^12] |
| claude.ai chat font toggle | Users can switch between "Anthropic Serif" (default), "Anthropic Sans", and a "Dyslexic friendly" option in Settings → General → Preferences | n/a | High — this is a documented, currently-live product setting [^8] |

CSS variables:
```css
--font-serif: 'Anthropic Serif', ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
--font-sans: 'Anthropic Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-mono: 'Anthropic Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

**Type scale** (from a third-party design-system audit of anthropic.com — not the CLI, and not official; use as inspirational reference only):[^9]
Caption 12px → body-sm 15px → body 16px → subheading 18px → heading-sm 20px → heading 24px → heading-lg 61px → display 91px, roughly a Major-Third (1.25×) progression. Weights used: 400, 500, 600, 700. Confidence: **low-medium** — this is an unofficial reverse-engineered style audit, not Anthropic's published spec.

Claude Code CLI itself is a monospace-only terminal grid — there is **no type scale** inside the TUI; all text renders in the user's terminal font at one size. Any "type scale" for a faithful web recreation of the *TUI portion* should therefore be a single monospace size (e.g., 14px/1.5 line-height) with the serif/sans scale reserved for a claude.ai-style *chat* skin, per the source split noted above.

### 1.3 Spacing, radius, borders (box-drawing aesthetic)

Claude Code's TUI is built on Ink with a custom Yoga (flexbox) layout engine, confirmed by the leaked-source repackaging projects that describe "Layout engine: Pure TypeScript port of Yoga" and "custom forked Ink". This means:[^13][^14]

- **Spacing** is expressed in terminal *character cells* (integer row/column padding), not px — typical Ink components use 1-cell padding around boxes and 1-row gaps between message blocks. For a web port, map 1 cell ≈ 8px (a common monospace-cell approximation), giving a spacing scale of `4px, 8px, 16px, 24px, 32px`. Confidence: **medium** — inferred from Ink/flexbox conventions, not an official spec.
- **Borders** use terminal box-drawing characters (single-line: `─│┌┐└┘`, rounded corners are not natively available in most terminal fonts, so Ink typically renders "round" borders using Unicode `╭╮╰╯` when the terminal font supports them). Claude Code's permission dialogs, plan-mode banner, and input box all render with a **1-cell colored border** whose color is the mode token (`promptBorder`, `permission`, `planMode`, `autoAccept`, `bashBorder`). Confidence: **high** for the token-driven border-coloring mechanism, **medium** for exact glyph choice (not documented, inferred from typical Ink `Box` `borderStyle="round"` usage in leaked-source descriptions).[^4]
- **Border radius**: terminal cells have no true radius; the "rounded" look comes from Unicode rounded corner glyphs. For a web CSS translation, use `border-radius: 6px` on cards/dialogs and `border-radius: 4px` on inline chips/buttons to approximate the visual softness while keeping the spirit of the box-drawing aesthetic — this is a **recommended web equivalent**, not a scraped value.

### 1.4 Motion / spinner specs

- The spinner displays a rotating gerund/verb ("Thinking…", "Cerebrating…", "Combobulating…") next to an animated glyph, drawn from a built-in list of **185 (some builds report 187) whimsical verbs**, confirmed identically across four independent extraction efforts. Confidence: **high** — this list is very consistently reproduced across sources.[^15][^16][^17][^18]
- The spinner list is user-customizable via `spinnerVerbs` in `settings.json` (`replace` or `append` mode), confirmed in official-style documentation and how-to guides. Confidence: **high**.[^19]
- Colors use a `claude`/`claudeShimmer` (and `warning`/`warningShimmer`, `permission`/`permissionShimmer`, etc.) paired-token system specifically to drive an **animated gradient shimmer** effect on the spinner and accent borders — confirmed directly in Anthropic's own terminal-config docs. Confidence: **high**.[^4]
- Recommended web equivalent: CSS `@keyframes` cycling a linear-gradient background-position between `claude` and `claudeShimmer` hex stops every ~120–200ms per verb frame (typical CLI spinner cadence), paired with a rotating verb `<span>` cross-fading every 2–3 seconds.

***

## 2. Component Inventory

| Component | Collapsed state | Expanded state | Source confidence |
|---|---|---|---|
| **Assistant message block** | Rendered inline with a `Claude` label (colored via `briefLabelClaude` token) and body text in `text` color; markdown-rendered | Same, plus code blocks get syntax highlighting and diffs get add/remove backgrounds | High — token names confirmed [^4]; layout inferred from Ink `Box` conventions, **medium** on exact spacing |
| **User message block** | Label `You` (via `briefLabelYou`), background tint `userMessageBackground` only in fullscreen renderer | Same; in fullscreen mode gets `userMessageBackgroundHover` on interaction | High for tokens [^4]; note fullscreen-only background is documented explicitly |
| **Tool-call card** | One-line summary, e.g., `Called slack 3 times` for MCP tools | Expands via `Ctrl+O` (toggle transcript) to show full tool input/output with timestamp and model used | High — directly documented [^20] |
| **Thinking / verbose block** | Hidden by default unless extended thinking is on (`Option+T`/`Alt+T`) | Ctrl+O reveals detailed reasoning trace alongside tool calls | High for toggle mechanics [^20][^21]; **low** on exact visual styling of thinking text (not documented — commonly italicized/dimmed in community recreations, unconfirmed officially) |
| **Todo-list widget** | Hidden | Toggled with `Ctrl+T` (`app:toggleTodos`) — shows Claude's to-do checklist as a status-area widget, distinct from the `/tasks` background-task view | High — directly documented action [^20] |
| **Permission prompt** | N/A — always shown modally when approval is needed | Options: **Yes**, **Yes, and don't ask again** (only offered when the prompt can preview the full scope of what it would allow), **No**; `Tab` opens a comment field on the focused option; border colored via `permission` token | High — behavior and option logic directly documented [^22][^20] |
| **Diff view** | Inline word/line diff with `diffAdded`/`diffRemoved` backgrounds | `/diff` opens a dedicated interactive viewer: left/right arrows switch between git-diff and per-turn diffs, up/down browses files, Enter opens a file's diff, Esc returns to file list | High — directly documented [^23][^4] |
| **Slash-command menu** | Triggered by typing `/` — filterable list including built-ins, skills, plugin/MCP commands | Tab or Enter accepts a highlighted match; mouse hover/click also works in fullscreen rendering | High — directly documented [^20] |
| **Status line / footer** | Custom bar at the bottom rendered from a user script (`statusLine` setting) — commonly shows model, directory, git branch, cost, context-window % | Same bar; color-coded thresholds (e.g., green <50%, yellow 50–80%, red >80% context usage) are a *community convention*, not a built-in default | High for mechanism (official settings docs) [^24][^25]; **medium** for color thresholds, which are commonly self-configured, not Anthropic defaults |
| **Spinner / working indicator** | Animated verb + glyph while a turn is in progress | N/A (no expanded state — it's a transient indicator) | High [^15][^19][^4] |
| **Session header** | Not explicitly documented as a discrete "header" component; `/status` command shows account, model, working directory, and version | N/A | Low — inferred; no dedicated "header" UI is named in docs, this may be a claude.ai web-chat concept rather than CLI |
| **Image attachments** | Inserted as a positional chip `[Image #N]` in the prompt on paste (`Ctrl+V`/`Alt+V`); navigable via arrow keys in an `Attachments` context (`Left`/`Right` cycle, `Backspace`/`Delete` removes) | Chip expands to show thumbnail navigation in select dialogs | High — directly documented keybinding context [^20][^26] |

**Terminal-specific vs. web-equivalent flags:**
- Box-drawing border glyphs, ANSI-256/true-color fallback, and the "fullscreen vs. classic renderer" distinction are inherently terminal-specific. Web equivalent: use CSS `border` + `border-radius` and forgo the classic/fullscreen split entirely (a web app is always "fullscreen").[^4]
- The `statusLine` shell-script mechanism is terminal-specific (stdin JSON → stdout string). Web equivalent: a persistent footer bar computed client-side from session state (model, branch, cost, context%) with no shell dependency.[^25]
- Vim editor mode and readline-style text editing are terminal-specific conveniences. Web equivalent: optional, non-default keybinding layer, since most web users expect standard OS text-field behavior.[^20]
- The literal 185-verb spinner list and the mascot ("Clawd") easter-egg tokens (`clawd_body`, `clawd_background`) are Claude-Code-specific whimsy; a web port can keep the verb list (it's brand voice) but drop terminal-only mascot ASCII art.[^15][^4]

***

## 3. Interaction Patterns

### 3.1 Keyboard map (Global/Chat context, from official docs)

| Key | Action | Notes | Source |
|---|---|---|---|
| `Esc` | Interrupt Claude mid-turn / close dialog / decline permission (same as "No" w/o comment) | Claude keeps completed work; if messages are queued, sends them next | High [^20][^27] |
| `Esc, Esc` (double-tap) | Clear input draft (if text present, saved to history) **or** open rewind/checkpoint menu (if input empty) — three options: rewind conversation only, rewind code only, rewind both | High, multiple convergent sources [^27][^28][^29][^30] |
| `Shift+Tab` (Alt+M on some Windows configs) | Cycle permission modes: `default(Manual) → acceptEdits → plan → [bypassPermissions] → [auto]` | Order and included modes vary slightly by which optional modes are enabled; official doc confirms this exact cycle | High [^20][^26] |
| `Ctrl+C` | Interrupt/cancel; empty prompt + second press exits | High [^20] |
| `Ctrl+D` | Exit (press twice within 800ms to confirm); deletes char-after-cursor if text present | High [^20] |
| `Ctrl+R` | Reverse search prompt history | High [^20] |
| `Ctrl+O` | Toggle verbose transcript viewer (tool calls, timestamps, model used) | High [^20] |
| `Ctrl+T` | Toggle Claude's to-do checklist (not the `/tasks` view) | High [^20] |
| `Ctrl+B` | Background the running task (tmux users press twice) | High [^20][^28] |
| `Ctrl+X Ctrl+K` | Kill all running background subagents (press twice within 3s to confirm) | High [^20] |
| `Ctrl+V` / `Alt+V` (Win/WSL) | Paste image from clipboard as `[Image #N]` chip | High [^20] |
| `Ctrl+J` | Insert newline without submitting | High [^20] |
| `Ctrl+X Enter` | Queue-submit — submits but waits its turn if Claude is mid-run | Requires v2.1.247+ | High [^20] |
| `Enter` | Submit message | High [^20] |
| `Up/Down` | Navigate cursor within multiline input, then command history once at first/last row; `Up` from first row also "takes back" queued messages | High [^20][^21] |
| `Option+P`/`Alt+P` | Switch model without clearing input | High [^20] |
| `Option+T`/`Alt+T` | Toggle extended thinking | High [^20] |
| `Option+O`/`Alt+O` | Toggle fast mode | High [^20] |
| `?` (empty input) | Toggle shortcut help panel | High [^20] |
| `@` + path | File-path autocomplete mention | High [^20] |
| `/` | Open slash-command menu | High [^20] |
| `!` at start | Shell mode — run command directly, output added to context | High [^20] |

### 3.2 Confirmation / permission-dialog keys

| Key | Action |
|---|---|
| `Y` / `Enter` | Confirm ("Yes") |
| `N` / `Esc` | Decline ("No") |
| `Tab` | Open/close a comment field on the focused option (Yes/No) |
| `Shift+Tab` | On a file permission prompt: closes comment field, or (no field open) selects "allow for rest of session" option when offered |
| `Space` | Toggle selection (multi-select contexts) |

All confirmed directly in official keybindings documentation.[^22][^20]

### 3.3 Interrupt behavior

Pressing `Esc` stops the current response or tool call mid-turn; **completed work is preserved**, not rolled back. If messages were queued during the run, Claude Code sends the queued messages immediately after the interrupt rather than discarding them. This is explicitly distinguished from `Esc, Esc`, which is a destructive/navigational action (clear draft or open rewind), not an interrupt.[^31][^20]

### 3.4 Message queueing during a run

Typing a message and pressing `Enter` while Claude is working **queues** it instead of interrupting the active turn; queued items appear above the input box. Queued items sent during tool calls are dispatched as soon as those tool calls finish, within the same turn; if multiple messages are still queued when a turn ends, only the oldest is sent next and the rest remain queued. Slash/shell commands are held until the turn ends, then run sequentially. Pressing `Up` from the first input row takes back (un-queues) a pending message. Confidence: **high**, directly documented.[^20]

### 3.5 Scrolling / pinning and focus/selection styles

Official docs confirm: in **fullscreen rendering mode**, scrolling uses mouse wheel or PageUp/PageDown inside the app rather than native terminal scrollback, and `Ctrl+End`/`scroll:bottom` "jumps to the latest message and **re-enables auto-follow**" — implying the transcript auto-pins to bottom by default and manual scroll-up temporarily un-pins it. Mouse-drag text selection uses `selectionBg` token color and dedicated `selection:extend*` actions (`Shift+Arrow` to extend selection, `Ctrl+Shift+C`/`Cmd+C` to copy). Confidence: **high** for the mechanics (directly documented), **medium** for the specific claim that this constitutes "auto-follow/pinning" since Anthropic's wording implies but doesn't explicitly name a "pin" feature — this is a reasonable inference, flagged as such. No dedicated "focus ring" or box-shadow styling is documented for the CLI (terminals don't have CSS focus states) — for a web port, a **recommended equivalent** is a 2px `claude`-colored outline on the active input/dialog.[^20]

***

## 4. Source Reliability Summary

| Source tier | Examples | What it's reliable for | What to treat with caution |
|---|---|---|---|
| Official Anthropic docs (`code.claude.com/docs`) | keybindings, interactive-mode, permissions, terminal-config, statusline, commands pages | Keyboard map, permission logic, token *names*, interaction mechanics, spinner verb customization | Does not publish literal default hex/RGB values for any theme token |
| Anthropic Help Center cheatsheet | support.claude.com cheatsheet | Cross-check of keyboard shortcuts and glossary | Slightly simplified vs. full docs |
| Community reverse-engineering (tweakcc, theme gists) | Piebald-AI/tweakcc, cameronsjo gist | Full 69-token catalog (34 tokens are undocumented-but-real, extracted from the shipped binary) | Exact default hex values reported only by tertiary blog posts, not the extraction source itself, and not cross-confirmed by Anthropic |
| Brand-color aggregator sites | uicolours.com, brandcolorshub.com, colorarchive.org, loftlyy.com | General direction/family of Anthropic's brand palette (warm orange, cream, near-black) | Sites disagree on exact hex (3–4 different oranges reported); none are Anthropic's own asset page, which was not publicly retrievable during this research |
| Community UI recreations (siteboon/claudecodeui, theswerd/brainless, Kanna, tweakcc themes) | Confirms which components (tool cards, diffs, permission dialogs, todo lists) are considered canonical enough to be worth recreating | Visual styling choices in these projects are the recreators' own interpretation, not verified against Anthropic source |
| Leaked-source repositories (multiple GitHub forks referencing a March 2026 npm sourcemap leak) | Confirms architecture claims (Ink + custom Yoga layout, React reconciler) | Not used here for literal color/pixel values; treated as corroboration of the token-driven, flexbox-based rendering model only |

***

## Confidence Statement

**Overall confidence: ~65%.**

High confidence (~90%+) applies to: the full keyboard shortcut map, permission-mode cycling and dialog semantics, interrupt/queueing behavior, the existence and names of all 69 theme tokens, the 185-verb spinner list, and the general two-typeface (Serif/Sans) + monospace font strategy — all of these are drawn directly from Anthropic's own current documentation or independently corroborated by 3+ sources.

Lower confidence (~30–50%) applies to: the *exact hex values* for Claude Code's default dark/light theme tokens (Anthropic doesn't publish these; the numbers above come from one secondary blog post reverse-engineering the binary, not a primary source I could independently verify pixel-for-pixel), the exact Anthropic brand orange hex (aggregator sites disagree between `#D97757`/`#CC785C`/`#C96442`/`#D4A27F`), the type scale numbers (from an unofficial third-party "design system" audit site, not Anthropic's real brand guidelines page, which returned no usable content when fetched directly), and stylistic details like border-radius, exact spacing-in-px, and thinking-block visual treatment (dimmed/italic), which are reasonable *inferences* from Ink/terminal conventions rather than confirmed specs.

**What I did not fabricate:** I did not invent any keyboard shortcut, token name, or interaction behavior — every specific claim traces to a fetched source, and I explicitly flagged every place where I made a recommendation/inference rather than reporting a sourced fact (border-radius px values, spacing-to-px conversion, focus-ring styling, and the auto-follow/pin naming). **What is genuinely uncertain and could be wrong:** the precise brand-orange hex code, the literal default RGB values of the ~30 theme tokens without a documented default, and the third-party type-scale numbers — these should be verified against Anthropic's actual brand asset kit (which I could not retrieve directly; anthropic.com/brand returned no content) before being hard-coded into a production design system. I'd estimate roughly 15–20% of the granular numeric values (specific hex codes, px spacing, type-scale numbers) are best-available approximations rather than confirmed-primary-source facts; the remaining ~80% (keyboard behavior, token architecture, component behavior, font family strategy) is solidly sourced.

---

## References

1. [Anthropic Brand Colours & Hex Codes - UIColours](https://uicolours.com/brands/anthropic) - Anthropic brand colour palette: #D97757, #FAF9F5, #141413. 5 official brand colours with HEX, RGB, H...

2. [Anthropic Brand Colors & Logo: HEX, RGB, HSL & CMYK Codes](https://brandcolorshub.com/brand/anthropic) - Anthropic uses 4 colors in its palette: Antique Brass (#CC785C), Cod Gray (#141413), Cararra (#F0EFE...

3. [Anthropic Color Palette — Hex Codes & Brand Colors | ColorArchive](https://colorarchive.org/brands/anthropic/) - Off-white on warm cream — the color of a research lab that values craft over flash.

4. [Configure your terminal for Claude Code](https://code.claude.com/docs/en/terminal-config)

5. [Claude Code Theme Reference - GitHub Gist](https://gist.github.com/cameronsjo/34a6fb8ade2b44c8380e1a2adebbac2b) - JSON Schema and reference doc covering all 69 color tokens for ~/.claude/themes/*.json (Claude Code ...

6. [Claude Code /theme: How to Change Themes (Dark, Light ...](https://blog.vincentqiao.com/en/posts/claude-code-theme/) - How to change your Claude Code theme: 7 options including dark, light, colorblind-friendly (daltoniz...

7. [[Question] Did the diff highlight colors (red/green background ...](https://github.com/anthropics/claude-code/issues/14144) - Description I noticed that the background highlight colors for diff display (added lines = green, re...

8. [Claude's Default Font Is a Problem — Here's How to Change It](https://www.itworkslocally.co.uk/blog/claudes-default-font-is-a-problem-heres-how-to-change-it) - Claude defaults to a serif font that's harder to read for many dyslexic users, and the setting to ch...

9. [Anthropic design system | Refero Styles](https://styles.refero.design/style/d469cba4-c448-4a43-a033-883f8bfcdc42) - Use Anthropic Serif at 20px for all body copy and Anthropic Sans at 12-16px for UI chrome — the seri...

10. [Anthropic brand colors hex codes, font, & logo download](https://www.loftlyy.com/en/anthropic) - Explore Anthropic brand assets on Loftlyy. Find brand colors and hex codes including #D4A27F, #19191...

11. [Claude AI Logo Color Codes, Fonts & Downloadable Assets](https://beginswithai.com/claude-ai-logo-color-codes-fonts-downloadable-assets/) - The primary font used for body text on the Claude AI website is a serif ... They're also using the A...

12. [Styrene in use: ANTHROP\C](https://type.today/en/journal/anthropic) - A sans serif named Styrene is an experiment exploring proportion. Typically narrow, these f, j, r, t...

13. [What's Stubbed Out](https://github.com/fazxes/claude-code) - Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and he...

14. [I studied Claude Code's leaked source and built a terminal UI toolkit from it](https://dev.to/minnzen/i-studied-claude-codes-leaked-source-and-built-a-terminal-ui-toolkit-from-it-4poh) - On March 31, 2026, Claude Code's full TypeScript source was accidentally exposed via npm source maps...

15. [Every Spinner Verb in Claude Code | Coding Cocoon](https://codingcocoon.com/posts/claude-code-all-spinner-verbs/) - The full list of 185 spinner verbs that appear while Claude Code is thinking.

16. [wynandw87/claude-code-spinner-verbs](https://github.com/wynandw87/claude-code-spinner-verbs) - 3600+ curated spinner verbs and spinner phrases for Claude Code. Cascading, Catapulting, Cerebrating...

17. [Discombobulating, Flibbertigibbeting & 60+ Slash Commands](https://www.linkedin.com/pulse/discombobulating-flibbertigibbeting-60-slash-commands-ramkumar-gcfxc) - You open your terminal. You type "claude".

18. [Clauding, Recombobulating, and the Funny Little Circle](https://krishnaclouds.github.io/2026/04/01/clauding-and-other-verbs/) - A while back, I wrote a LinkedIn post about the language of the modern developer — how the vocabular...

19. [How to Customize Claude Code's Spinner Verbs (and why ...](https://www.alexandrasamuel.com/ai/customize-claude-code-spinner-verbs) - Short answer: Claude Code lets you replace the little status words that flash while it's working ("C...

20. [Customize keyboard shortcuts - Claude Code Docs](https://code.claude.com/docs/en/keybindings) - Customize keyboard shortcuts in Claude Code. Enter or Tab places the highlighted match in the prompt...

21. [You're Using Claude Wrong: The Shortcut Layer ... - Medium](https://thomaskidu.medium.com/claude-shortcuts-that-actually-save-you-time-web-desktop-and-claude-code-f272020c3bc4) - The Claude Shortcut Layer Most Developers Miss

22. [Configure permissions - Claude Code Docs](https://code.claude.com/docs/en/permissions)

23. [Commands - Claude Code Docs](https://code.claude.com/docs/en/commands)

24. [Claude Code Status Line Setup Guide (Scripts + Examples)](https://claudefa.st/blog/tools/statusline-guide) - Claude Fast | Set up a custom Claude Code status line showing model name, git branch, cost, and cont...

25. [Personalize sua linha de status - Claude Code Docs](https://code.claude.com/docs/pt/statusline)

26. [Choose a permission mode - Claude Code Docs](https://code.claude.com/docs/en/permission-modes)

27. [Claude Code cheatsheet | Anthropic Help Center](https://support.claude.com/en/articles/14553413-claude-code-cheatsheet) - Keyboard shortcuts ; Shift + Tab. Cycle permission mode: auto → manual → acceptEdits → plan . Also i...

28. [Claude Code Cheat Sheet – Commands, Shortcuts, Tips](https://computingforgeeks.com/claude-code-cheat-sheet/) - Claude Code cheat sheet for 2.1.x: Opus 4.8 default, background agents, slash commands, CLI flags, /...

29. [18 Shortcuts & Commands for Designers to Master Claude ...](https://note.com/ohara_designer/n/n3742df6f287b?hl=en) - People often ask me, "Isn't Claude Code a tool for engineers?" But as a UI designer, I use Claude Co...

30. [Claude Code Slash Commands](https://www.datacamp.com/tutorial/claude-code-slash-commands) - Learn how to use the built-in Claude Code slash commands to manage context, changes, and costs, and ...

31. [Claude Code Shortcuts Cheat Sheet 2026 (PDF Download)](https://promptslove.com/blog/claude-code-shortcuts-cheat-sheet/) - The complete Claude Code shortcuts reference for 2026. Keyboard shortcuts, 80+ slash commands, 60+ C...

