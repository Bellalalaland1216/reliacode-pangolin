# ReliaCode UI icon policy

ReliaCode is a cross-platform web service. Apple Design Resources and exported
SF Symbols are not embedded or redistributed in the product because Apple's
resource license does not permit those assets to be distributed as website
content or used for products that also run on non-Apple platforms.

The production interface instead uses an original, self-contained SVG symbol
sprite at `/public/icons/ui.svg`. Its design follows Apple's interface-icon
guidance:

- simple, recognizable glyphs with one concept per symbol;
- a consistent 24 by 24 coordinate grid, stroke weight, alignment, and perspective;
- monochrome rendering inherited from the surrounding text color;
- visible text labels for navigation and accessible labels for icon-only controls;
- no remote assets, scripts, raster images, embedded styles, or trademarked
  Apple product shapes.

Decorative SVG elements must use `aria-hidden="true"`. An icon-only interactive
control must provide an `aria-label` describing the action. New symbols must be
added to the local sprite and covered by the monochrome UI contract tests.

References:

- Apple Human Interface Guidelines: Icons
- Apple Human Interface Guidelines: SF Symbols
- Apple Design Resources License Agreement
