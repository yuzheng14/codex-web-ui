# Covro brand assets

The mark combines an open **C** with a terminal prompt. Its rounded frame represents a workspace you can return to from another device. The wordmark is drawn as SVG paths and circles, so it needs no installed font.

| Asset                                        | Use                                             |
| -------------------------------------------- | ----------------------------------------------- |
| [Square mark](../public/covro.svg)           | App icon, favicon, avatars; square aspect ratio |
| [Wordmark](assets/covro-logo.svg)            | Light backgrounds                               |
| [Light wordmark](assets/covro-logo-dark.svg) | Dark backgrounds                                |

All three assets are editable vector SVGs, with transparent space around the artwork and no embedded raster images, scripts, external resources, or font dependencies. They use the project's MIT license.

Use the square mark at 16px or larger. Keep the original aspect ratio and at least one tenth of the mark's width as clear space. The primary green is `#243D34`; the light ink is `#F2F7F0`, with `#AFD5B7` on the prompt.

To refresh the README screenshots, run `pnpm build` and then `node --import tsx scripts/capture-readme.ts`. This starts an isolated gateway with explicit sample history and the existing protocol fixture. It captures the actual desktop and mobile pages, makes no model requests, and cleans up its temporary service and data. Keep the screenshot captions in both README files.
