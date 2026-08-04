# NovelFlow Creative Studio Design System

NovelFlow is a working creative studio for high-volume fiction promotion. It should feel focused and sophisticated, with enough visual energy to invite creation without turning an operations tool into a marketing page.

## Product Character

- Linear-like operational clarity: compact controls, visible state, hairline borders, predictable navigation.
- Runway-like creative energy: cover art is prominent, finished media feels like work worth publishing, primary creation actions are unmistakable.
- The first viewport answers three questions: what should I create, what is running, and where are my finished assets.
- Preserve functional IDs and event contracts when redesigning existing controls.

## Color

- Canvas: `#f4f5f7`
- Paper: `#ffffff`
- Ink: `#17191d`
- Muted ink: `#69717d`
- Hairline: `#dde1e7`
- Deep studio surface: `#15171b`
- Primary action: `#ec4c6a`
- Primary hover: `#d93d5a`
- Operational green: `#0b8f6a`
- Data blue: `#5367e8`
- Warning amber: `#b87916`

Do not use gradients. Do not let a single hue dominate the whole product. Use semantic colors only where they carry meaning.

## Type

- Use system UI fonts: `Inter`, `Segoe UI Variable`, `Microsoft YaHei`, sans-serif.
- Letter spacing is always `0`.
- Studio page title: 32-36px, weight 720-780.
- Section title: 20-24px, weight 720.
- Card title: 13-15px, weight 720.
- Body: 11-13px. Metadata: 9-11px.
- Never scale font size with viewport width.

## Geometry

- Base spacing unit: 4px.
- Buttons and inputs: 6px radius.
- Repeated cards and panels: 8px radius maximum.
- Use shadows only on creative media and active hover states. Operational panels use surfaces and hairlines.
- Fixed-format media uses explicit aspect ratios so loading never shifts layout.

## Main Surfaces

- Top bar: light, 60px, persistent global status and new-creation action.
- Sidebar: fixed deep surface, 220px, one obvious creation action and four predictable views.
- Studio opener: deep full-width band, not a floating card. Primary action is coral; secondary actions are transparent dark-surface controls.
- Today's picks: horizontal cover-led rail with snap scrolling and visible navigation.
- Book picker: unframed section with a sticky compact filter bar; books are the only repeated cards.
- Production list: dense rows with strong cover, 7-node progress, tracking identifier and explicit state.
- Asset library: media-first cards with stable previews, direct copy/open/delete actions.

## Interaction

- The primary action always starts or continues creation.
- Hover may lift a creative card by at most 2px; no decorative animation loops.
- Selected books receive a clear outline and check state.
- Running states use motion only on the relevant icon or progress indicator.
- Failed branches are not promoted as the main experience. Archived failures stay out of normal lists.
- Respect `prefers-reduced-motion`.

## Responsive

- Desktop: fixed sidebar, maximum content width 1560px, three book cards at wide widths and two at ordinary laptop widths.
- Tablet: sidebar becomes compact, filters wrap, book cards use two columns.
- Mobile: one column, horizontal recommendation rail, no text overlap, controls remain at least 36px tall.
