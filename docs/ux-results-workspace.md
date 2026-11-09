# Results workspace and reduced scrolling

Scope: local Systems Lab, existing user testing a code sandbox/project. Primary tasks: select project, start app, run chosen load, interpret failures, inspect raw output, customize requirements. Observed problem: long vertically stacked pages and hundreds of repeated timeouts. User expertise and assistive-technology setup are unknown; no persona is assumed.

## Flow and recovery

| Stage | Needed information | Action and feedback | Hesitation/error | Recovery/success |
|---|---|---|---|---|
| First use | Selected project, runtime readiness | Project tab, prepare/start status | Confusing demo with project | Explicit target names and persistent run controls |
| Routine test | User count, ramp, duration, current target | Run and stop remain visible | Expecting configured users to equal RPS | Plain-language metrics and actual run metadata |
| Failed test | Failed count, long-tail latency, recent error classes | Results beside technical output | Reading repeated logs as separate root causes | Group recent entries; link to requests/script; preserve terminal |
| Inspect detail | Exact lines and service | Filter/pause/copy/download terminal | Output moving while reading | Pause and follow controls; bounded scroll region |
| Plan changes | Measurements versus custom goals | Measurements tab and edit controls | Assuming test discovers business targets | Explicit automatic/custom/unknown provenance |

## Evidence ledger

| Source | Participants/task and finding | Confidence and boundary | Design implication | Falsifier |
|---|---|---|---|---|
| [Cowan 2001](https://pubmed.ncbi.nlm.nih.gov/11515286/) | Review of short-term-memory paradigms, not a dashboard-user study. Capacity depends on identifiable chunks and suppression of rehearsal/long-term recoding. | Strong for constrained memory tasks; analogy-only for this interface. No rule to show exactly four items. | Keep target/run status visible and group related facts rather than asking users to remember them across long pages. | Users still misidentify target or cannot explain outcome without returning to previous pages. |
| [Scheibehenne et al. 2010](https://academic.oup.com/jcr/article/37/3/409/1827647) | 63 conditions from 50 published/unpublished experiments, N=5,036; mean choice-overload effect near zero with considerable heterogeneity. | Strong corrective synthesis; consumer-choice tasks differ from developer monitoring. | Preserve all project/resource options; improve grouping, search and comparison instead of deleting capabilities under a universal option limit. | Important controls become harder to find or error recovery takes more steps. |
| [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) | Accessibility criterion, no participant sample. Avoid loss of information/function and two-dimensional scrolling at 320 CSS px, with qualified exceptions for tables/editors. | Normative requirement plus informative explanation; not empirical proof of usability. | Compact desktop shell, responsive document flow on narrow/short/zoomed views; code/terminal can scroll within bounded regions. | Horizontal body overflow, clipped labels/actions, inaccessible off-screen content at 320px or zoom. |
| [W3C Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Accessibility criterion, no participant sample. Author-created headers/footers must not completely hide focused controls. | Normative minimum, not a full usability guarantee. | Reserve layout space for run controls, visible focus, scroll padding and native dialogs; do not overlay the run bar on content. | Keyboard focus falls behind sticky chrome or cannot reach a region. |

The primary abstract of the choice meta-analysis was read using agent-reach/Exa; the publisher page failed to open through the secondary web reader. No new gallery composition or animation system is required.

## UI route and decisions

Route: `ui-design-index` → `ui-design-systems`. Compatible patterns: task tabs within Infrastructure; compact persistent run controls; split results and terminal with neutral card surfaces. Preserve existing light/dark tokens and native HTML controls. No decorative animation, no root-cause certainty from a recent-log sample, no hiding errors to make a run look healthy.

Desktop default views should fit 1280×800 with primary actions visible and bounded content regions. Infrastructure tabs retain Project, Resources, Measurements and Usage. Advanced worksheet/help opens when requested; navigating pages resets inappropriate old scroll positions. Narrow/short viewports return to accessible document flow, with summary/terminal modes instead of squeezing two columns.

Run failure total comes from all k6 requests. Error-category counts explicitly describe only the retained 160 log entries. p50/p95/p99 describe retained request samples. A timeout is an observed symptom, not proof of CPU saturation or the cause of every failed request.

Verification: healthy/error/empty states, pause/filter/copy/download output, automatic/custom fields, each default page at desktop, 320/375/768 widths, keyboard tabs, light/dark and short-height/zoom reflow. Expected comprehension benefits remain unverified until a focused human test: identify the failed run, its target and likely next check without reading raw logs or assistance.


## Observed validation in this implementation

- Chromium: all six default pages at 1280×800 had document height 800px, main height 748px, and the Run button bottom at 775px. Work areas use bounded scrolling; this does not mean every advanced setting is simultaneously visible.
- Split results use the captured 1,000-user failure fixture: 18,841 requests, 2,147 failed, 11.395% failure rate and p99 about 5,489.65 ms. Fixture data never changed the real stored project notes.
- Passed grouped-error sample labeling, pause/resume, service/text filtering, clipboard copy, output download, summary/terminal mode selection, healthy and empty states.
- Passed keyboard navigation between Infrastructure tabs and project-dropdown viewport positioning.
- Passed 768/375/320 CSS pixel body-width checks and 1280×600 reflow. No JavaScript page errors. These are scoped checks, not a declaration of complete WCAG conformance.
- Automatic-value browser regression passed: measured fields populate, custom values survive newer observations, Use automatic restores latest data, unmeasurable fields remain blank.
- Artifacts: /tmp/systems-lab-results-desktop.png, /tmp/systems-lab-results-mobile.png, /tmp/systems-lab-resources-compact.png. Browser harnesses: /tmp/systems-lab-results-browser.cjs and /tmp/systems-lab-automatic-browser.cjs.

Final layout keeps the run status in the run toolbar and detailed measurements in Results, removing duplicated metric tiles. Existing read-only metric DOM remains for compatibility. No timeout values, fault injection, resource caps or service application code was changed by the results-layout work.
