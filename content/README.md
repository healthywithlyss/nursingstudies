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
guide's own course tab (NUR 144, NUR 146, …) and the Study Guide page on load.

A new course folder also wants a display name; add it to `COURSE_META` at the
top of `scripts/build-guides-manifest.js` (otherwise the folder name is used).

## What the page does with the markdown

The guides render in the same layout as the NUR 118 guide: every lecture of
the course stacked on one page under a blue unit banner, a coloured lecture
bar per lecture (colours cycle teal, plum, rust, forest, cobalt, slate, gold),
one white panel per H2 section headed by an uppercase sub-bar, and the H3
blocks inside a section as band cards two across. The sidebar lists the
lectures. Nothing collapses and there are no checkboxes.

| In the markdown          | On the page |
|--------------------------|-------------|
| `# Heading`              | Not shown directly; the file's identity comes from the manifest |
| `## Heading` (first one, directly under the H1) | The lecture name — on the lecture bar, the unit banner and the sidebar |
| Text between the H1 and the first section | Small muted "sources" block at the top of the lecture |
| `## Objectives` / `## Learning objectives …` as the first section | The ☑ Objectives box |
| `## Heading` (all others)| A white panel with an uppercase sub-bar |
| `### Heading`            | A band card; cards sit two across, and a card holding a table, a diagram or a lot of text takes the full row |
| GFM table                | Styled table that scrolls sideways on a phone; four or more columns keep the first column pinned while swiping |
| `> quote`                | Orange warning callout |
| `**Why:** …` / `**Why that matters:** …` (any bold lead starting with "Why" and ending in a colon) | Blue mechanism callout |
| `★ ⊕ ⊙ ⚠`               | Left in the text exactly as written |
| `**Description:** …`     | Optional; kept in the manifest for tooling, not shown |

## Notes

- A referenced image that isn't in `images/` renders as a labelled placeholder
  naming the missing file, so it's visible what still needs adding.
- The markdown renderer is vendored at `vendor/marked.min.js` (marked v12.0.2,
  MIT — see `vendor/marked.LICENSE.md`). Nothing on this page loads from a CDN.
  It is still loaded lazily, only when a guide is opened.
- After the first visit, the renderer, the manifest and every guide's markdown
  are pulled into the browser cache, so guides keep working with no signal.
  Images are not pre-cached (several MB) — they cache once viewed.
