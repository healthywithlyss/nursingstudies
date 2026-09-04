# Study guide content

NUR 144 is a course tab in the top switcher, alongside NUR 116 and NUR 118.
Selecting it points the **Study Guide** nav item at the markdown guides below;
Practice, Quiz and Dashboard show an empty state, because the course has no
flashcard or quiz data and is not meant to.

The guides are plain markdown files served as static assets. Nothing here is in
the database — to change a guide, edit the `.md` file and redeploy.

```
content/
  study-guides.json          <- generated index, do not hand-edit
  nur144/
    NUR144_Unit1_Lecture1_StudyGuide.md
    images/
      referred-abdominal-pain.png
      ...
```

## Adding a guide

1. Drop the `.md` file into `content/<course>/` (create the folder for a new
   course). Name it using the convention below — that is what determines the
   unit and lecture ordering on the index page:

   | Filename                                | Shows up as             |
   |-----------------------------------------|-------------------------|
   | `NUR144_Unit1_Lecture2_StudyGuide.md`    | NUR 144 · Unit 1 · Lecture 2 |
   | `NUR144_Unit2_Lecture1_StudyGuide.md`    | NUR 144 · Unit 2 · Lecture 1 |
   | `NUR144_Unit1_LabSkills_StudyGuide.md`   | NUR 144 · Unit 1 · Lab Skills |

2. Put any images in `content/<course>/images/` and reference them from the
   markdown with a relative path, exactly as the file already does:
   `![Alt text describing the diagram](images/my-diagram.png)`.
   The alt text becomes the caption and the lightbox label, so write a real one.

3. Regenerate the index and commit it:

   ```
   node scripts/build-guides-manifest.js          # writes content/study-guides.json
   node scripts/build-guides-manifest.js --check  # verifies it is up to date, exits 1 if not
   ```

   If you forget, the Study Guides index page says so: it probes for the next
   few lecture files in each unit and shows a warning naming any `.md` that
   exists but isn't indexed (and any manifest entry whose file has gone).

4. Commit the `.md`, the images, and the regenerated `content/study-guides.json`,
   then redeploy. The guide appears automatically — no code change needed.

A guide is reachable directly at `#/study-guides/<slug>`, which selects the
NUR 144 tab and the Study Guide page on load.

A new course folder also wants a display name; add it to `COURSE_META` at the
top of `scripts/build-guides-manifest.js` (otherwise the folder name is used).

## What the page does with the markdown

One `.md` file is one lecture. Its H2s are subsections *of* that lecture, shown
nested under a lecture header (unit label → lecture bar → numbered subsections),
matching how the NUR 118 guide nests unit → lecture → `.sub` labels.

| In the markdown          | On the page |
|--------------------------|-------------|
| `# Heading`              | Not shown directly; the file's identity comes from the manifest |
| `## Heading` (first one, directly under the H1) | The lecture name — on the lecture header bar and the index card |
| `## Heading` (all others)| A numbered, independently collapsible subsection of the lecture, plus a contents entry |
| `### Heading`            | Sub-header inside a subsection |
| GFM table                | Styled table that scrolls sideways on a phone |
| `> quote`                | Orange warning callout |
| `**Why:** …` / `**Why that matters:** …` (any bold lead starting with "Why" and ending in a colon) | Blue mechanism callout |
| `★`                      | Accent badge — "Professor flagged this as must-know" |
| `⊕`                      | Badge — "Added from textbook — slide listed the topic only" |
| `⊙`                      | Badge — "Textbook detail — slide named it without explaining" |
| `⚠`                      | Warning badge |
| `**Description:** …`     | Optional; overrides the auto-generated index-card blurb |

A subsection counts as "must-know" (and survives the **★ Must-know only**
filter) if a `★` appears anywhere in its heading or body.

## Notes

- "Reviewed" checkboxes are stored in `localStorage` under
  `nur_sg_progress_<guide-slug>`, keyed by a slug derived from the subsection
  heading. Renaming a heading resets that one subsection's checkbox.
- A referenced image that isn't in `images/` renders as a labelled placeholder
  naming the missing file, so it's visible what still needs adding.
- The markdown renderer is vendored at `vendor/marked.min.js` (marked v12.0.2,
  MIT — see `vendor/marked.LICENSE.md`). Nothing on this page loads from a CDN.
  It is still loaded lazily, only when a guide is opened.
- After the first visit, the renderer, the manifest and every guide's markdown
  are pulled into the browser cache, so guides keep working with no signal.
  Images are not pre-cached (several MB) — they cache once viewed.
