# Skyscrape design system

The approved Permit Register pairs a compact results table with a persistent field evidence pane. A modal with the same evidence content replaces the pane on narrow screens.

## Tokens

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | `#FFFFFF` | `#000000` |
| Navigation | `#303034` | `#303034` |
| Primary action | `#FFD33D` | `#FFD33D` |
| Text on yellow | `#171717` | `#171717` |
| Text | `#171717` | `#F5F5F4` |
| Panel | `#FFFFFF` | `#0E0E0F` |
| Selected row | `#FFF6D5` | `#2C2513` |
| Focus ring | `#876300` | `#FFD33D` |

Use system sans for labels and body, a system monospace face for identifiers and raw values, and tabular numerals for dates and counts. Keep data rows at 52 px where values fit on one line. Use 6–8 px corners. Pair semantic color with visible state text. On narrow screens, let only the table scroll horizontally.

The appearance control sits at the bottom of the desktop navigation and inside the navigation menu on narrow screens. Store only the System, Light, or Dark preference locally. System follows the device and applies OS changes without a reload.

## Routes

| Route | Shell behavior |
| --- | --- |
| `/` | Opens the Permit Register. |
| `/records` | Lists permitted records with exact jurisdiction and permit number filters. |
| `/records/permit/:id` | Opens the selected record and the observations available to the signed-in role. |
| `/overview`, `/campaigns/*`, `/runs/*`, `/research/*`, `/sources/*`, `/issues/*`, `/exports/*`, `/help/*`, `/admin/*` | Shows a permission-aware unavailable state until each feature connects its routes. |

Use the navigation and the workspace command menu to reach the same route definitions. The API authorizes every read independently. The UI renders record values separately from source observation metadata. Observation-specific values, source excerpts, and raw artifacts require a future authorized API projection.

## References

The installed UI Styling 1.0.0 (`ui-styling/SKILL.md`) informed semantic tokens and Radix dialogs. UI/UX Pro Max (`ui-ux-pro-max/SKILL.md`) informed compact data layout, text contrast, and focus states. Impeccable 4.5.0 (`impeccable/SKILL.md`) informed implementation against the approved mockup and verification of the responsive layouts.
