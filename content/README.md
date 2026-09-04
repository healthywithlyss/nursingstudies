# Study guide content

Guides on the **Study Guides** page are plain markdown files served as static
assets. Nothing here is in the database — to change a guide, edit the `.md`
file and redeploy.

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
   node scripts/build-guides-manifest.js
   ```

4. Commit the `.md`, the images, and the regenerated `content/study-guides.json`,
   then redeploy. The guide appears automatically — no code change needed.

A new course folder also wants a display name; add it to `COURSE_META` at the
top of `scripts/build-guides-manifest.js` (otherwise the folder name is used).

## What the page does with the markdown

| In the markdown          | On the page |
|--------------------------|-------------|
| `# Heading`              | Guide title |
| `## Heading` (first one, directly under the H1) | Subtitle, and the headline on the index card |
| `## Heading` (all others)| An independently collapsible section + a table-of-contents entry |
| `### Heading`            | Coloured sub-header, tinted to match its section |
| GFM table                | Styled table that scrolls sideways on a phone |
| `> quote`                | Orange warning callout |
| `**Why:** …` / `**Why that matters:** …` (any bold lead starting with "Why" and ending in a colon) | Blue mechanism callout |
| `★`                      | Accent badge — "Professor flagged this as must-know" |
| `⊕`                      | Badge — "Added from textbook — slide listed the topic only" |
| `⊙`                      | Badge — "Textbook detail — slide named it without explaining" |
| `⚠`                      | Warning badge |
| `**Description:** …`     | Optional; overrides the auto-generated index-card blurb |

A section counts as "must-know" (and survives the **★ Must-know only** filter)
if a `★` appears anywhere in its heading or body.

## Notes

- "Reviewed" checkboxes are stored in `localStorage` under
  `nur_sg_progress_<guide-slug>`, keyed by a slug derived from the section
  heading. Renaming a heading resets that one section's checkbox.
- A referenced image that isn't in `images/` renders as a labelled placeholder
  naming the missing file, so it's visible what still needs adding.
