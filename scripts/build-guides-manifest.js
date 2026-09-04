#!/usr/bin/env node
/*
  build-guides-manifest.js
  ------------------------
  Scans content/<course>/ for *.md study guides and writes content/study-guides.json,
  which the Study Guides page fetches at runtime.

  The app is a static site, so the browser cannot list a directory — this script is
  what turns "drop a .md file in" into "it shows up in the app".

  Usage:  node scripts/build-guides-manifest.js            write content/study-guides.json
          node scripts/build-guides-manifest.js --check    verify it is up to date

  Run it after adding/renaming/removing a .md file, then commit the regenerated
  JSON. --check writes nothing and exits 1 when the committed manifest no longer
  matches what is on disk, so it can gate a deploy or a CI job.

  Filename convention (this is how unit / lecture ordering is derived):
      NUR144_Unit1_Lecture1_StudyGuide.md   -> NUR 144, Unit 1, Lecture 1
      NUR144_Unit1_Lecture2_StudyGuide.md   -> NUR 144, Unit 1, Lecture 2
      NUR144_Unit1_LabSkills_StudyGuide.md  -> NUR 144, Unit 1, "Lab Skills"
  A file that doesn't match still gets picked up; it just lands in an "Other" unit.

  Metadata comes from the markdown itself:
      # Title                 -> page title
      ## Subtitle             -> only when it directly follows the H1; used as the card headline
      **Description:** ...    -> optional one-line override for the card blurb
  With no **Description:** line, the blurb is built from the first few H2 section
  names, so a new guide gets a sensible card without any extra authoring.
*/

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var CONTENT_DIR = path.join(ROOT, 'content');
var OUT_FILE = path.join(CONTENT_DIR, 'study-guides.json');

var COURSE_META = {
  NUR144: { label: 'NUR 144', title: 'Medical-Surgical Nursing' },
  NUR118: { label: 'NUR 118', title: 'Fundamentals of Nursing' },
  NUR116: { label: 'NUR 116', title: 'Nursing Concepts' }
};

function slugify(s){
  return String(s).toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/* Strip the marker glyphs so they don't end up in titles/descriptions. */
function stripMarkers(s){
  return String(s).replace(/[★⊕⊙⚠]️?/g, '').replace(/\s{2,}/g, ' ').trim();
}

/* Very small inline-markdown -> plain text, for card blurbs. */
function plainText(s){
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function parseFileName(name){
  var base = name.replace(/\.md$/i, '');
  var m = base.match(/^(NUR\d+)_Unit(\d+)_(?:Lecture(\d+)|([A-Za-z][A-Za-z0-9]*))/i);
  if (!m) return { course: null, unit: null, lecture: null, kind: null };
  return {
    course: m[1].toUpperCase(),
    unit: parseInt(m[2], 10),
    lecture: m[3] ? parseInt(m[3], 10) : null,
    /* "LabSkills" -> "Lab Skills" */
    kind: m[4] ? m[4].replace(/([a-z])([A-Z])/g, '$1 $2') : null
  };
}

function parseMarkdown(text){
  var lines = text.split(/\r?\n/);
  var title = null, subtitle = null, description = null;
  var sections = [];       /* H2 headings */
  var mustKnow = 0;        /* number of star markers */
  var i;

  for (i = 0; i < lines.length; i++){
    var line = lines[i];

    if (title === null && /^#\s+/.test(line)){
      title = stripMarkers(plainText(line.replace(/^#\s+/, '')));
      /* a subtitle is an H2 on the next non-blank line, before any rule */
      for (var j = i + 1; j < lines.length; j++){
        if (!lines[j].trim()) continue;
        if (/^##\s+/.test(lines[j])) subtitle = stripMarkers(plainText(lines[j].replace(/^##\s+/, '')));
        break;
      }
      continue;
    }

    if (description === null){
      var d = line.match(/^\*\*Description:\*\*\s*(.+)$/i);
      if (d) { description = plainText(d[1]); continue; }
    }

    /* H2s after the subtitle become the collapsible sections */
    if (/^##\s+(?!#)/.test(line)){
      var h = stripMarkers(plainText(line.replace(/^##\s+/, '')));
      if (h && h !== subtitle) sections.push(h);
    }

    mustKnow += (line.match(/★/g) || []).length;
  }

  return {
    title: title,
    subtitle: subtitle,
    description: description,
    topics: sections.slice(0, 4),
    sectionCount: sections.length,
    mustKnowCount: mustKnow
  };
}

function generate(){
  if (!fs.existsSync(CONTENT_DIR)){
    console.error('No content/ directory found at ' + CONTENT_DIR);
    process.exit(1);
  }

  var courseDirs = fs.readdirSync(CONTENT_DIR).filter(function(d){
    return fs.statSync(path.join(CONTENT_DIR, d)).isDirectory();
  }).sort();

  var courses = [];
  var totalGuides = 0;

  courseDirs.forEach(function(dir){
    var files = fs.readdirSync(path.join(CONTENT_DIR, dir))
      .filter(function(f){ return /\.md$/i.test(f); })
      .sort();
    if (!files.length) return;

    var courseCode = dir.toUpperCase();
    var unitsMap = {};

    files.forEach(function(file){
      var fullPath = path.join(CONTENT_DIR, dir, file);
      var text = fs.readFileSync(fullPath, 'utf8');
      var meta = parseMarkdown(text);
      var fromName = parseFileName(file);

      var code = fromName.course || courseCode;
      var unit = fromName.unit;
      var lectureLabel = fromName.lecture !== null
        ? 'Lecture ' + fromName.lecture
        : (fromName.kind || 'Guide');

      var slug = slugify(code + '-' +
        (unit !== null ? 'u' + unit + '-' : '') +
        (fromName.lecture !== null ? 'l' + fromName.lecture : (fromName.kind || file.replace(/\.md$/i, ''))));

      var guide = {
        slug: slug,
        file: 'content/' + dir + '/' + file,
        imageBase: 'content/' + dir + '/',
        course: code,
        unit: unit,
        lecture: fromName.lecture,
        lectureLabel: lectureLabel,
        title: meta.title || file.replace(/\.md$/i, ''),
        subtitle: meta.subtitle || '',
        /* headline shown on the index card — the H1 is usually just
           "NUR 144 — UNIT 1, LECTURE 1", which the card already says in its badges */
        cardTitle: meta.subtitle || meta.title || file.replace(/\.md$/i, ''),
        description: meta.description || '',
        topics: meta.topics,
        sectionCount: meta.sectionCount,
        mustKnowCount: meta.mustKnowCount
      };

      var key = unit === null ? 'other' : String(unit);
      if (!unitsMap[key]) {
        unitsMap[key] = { unit: unit, label: unit === null ? 'Other' : 'Unit ' + unit, guides: [] };
      }
      unitsMap[key].guides.push(guide);
      totalGuides++;
    });

    var units = Object.keys(unitsMap).map(function(k){ return unitsMap[k]; });
    units.sort(function(a, b){
      if (a.unit === null) return 1;
      if (b.unit === null) return -1;
      return a.unit - b.unit;
    });
    units.forEach(function(u){
      u.guides.sort(function(a, b){
        /* numbered lectures first, in order; then named guides alphabetically */
        if (a.lecture !== null && b.lecture !== null) return a.lecture - b.lecture;
        if (a.lecture !== null) return -1;
        if (b.lecture !== null) return 1;
        return a.lectureLabel.localeCompare(b.lectureLabel);
      });
    });

    var cm = COURSE_META[courseCode] || {};
    courses.push({
      code: courseCode,
      label: cm.label || courseCode,
      title: cm.title || '',
      units: units
    });
  });

  return { courses: courses, totalGuides: totalGuides };
}

function summarise(courses){
  var lines = [];
  courses.forEach(function(c){
    c.units.forEach(function(u){
      u.guides.forEach(function(g){
        lines.push('  ' + c.label + ' · ' + u.label + ' · ' + g.lectureLabel +
          ' — ' + g.title + '  (' + g.sectionCount + ' sections, ' + g.mustKnowCount + ' ★)');
      });
    });
  });
  return lines;
}

/* generatedAt changes on every run, so compare only the content that matters */
function comparable(courses){ return JSON.stringify(courses || []); }

function main(){
  var check = process.argv.indexOf('--check') !== -1;
  var result = generate();

  if (check){
    var current;
    try { current = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); }
    catch (e){
      console.error('content/study-guides.json is missing or unreadable.');
      console.error('Run: node scripts/build-guides-manifest.js');
      process.exit(1);
    }
    if (comparable(current.courses) !== comparable(result.courses)){
      console.error('content/study-guides.json is OUT OF DATE.');
      console.error('Guides currently on disk:');
      summarise(result.courses).forEach(function(l){ console.error(l); });
      console.error('');
      console.error('Run: node scripts/build-guides-manifest.js   (then commit the result)');
      process.exit(1);
    }
    console.log('content/study-guides.json is up to date (' + result.totalGuides + ' guide(s)).');
    return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/build-guides-manifest.js',
    courses: result.courses
  }, null, 2) + '\n', 'utf8');

  console.log('Wrote ' + path.relative(ROOT, OUT_FILE));
  summarise(result.courses).forEach(function(l){ console.log(l); });
  console.log(result.totalGuides + ' guide(s) total.');
}

main();
