# -*- coding: utf-8 -*-
"""Render the submission email to a print-ready HTML file.

Only the constructs the email actually uses are handled: headings, tables,
fenced code, bullet lists, horizontal rules, bold, italic, inline code and
links. Anything more would be a markdown library, and this needs to run
without one.
"""
import io
import re
import html as htmlmod

SRC = 'docs/SUBMISSION-EMAIL.md'
OUT = 'docs/submission-email.html'

text = io.open(SRC, encoding='utf-8').read()

# Drop the editor's preamble: the PDF is the email, not a note about it.
text = text[text.index('**Subject:**'):]

# Drop the "what done means" section, up to the rule that closes it.
start = text.find('## Against your "what done means" list')
if start != -1:
    end = text.index('\n---\n', start) + len('\n---\n')
    text = text[:start] + text[end:]

# Collapse the run of rules left behind by the excision.
text = re.sub(r'(?:\n---\n\s*){2,}', '\n---\n\n', text)


def inline(s):
    """Inline markdown, escaped first so the source cannot inject markup."""
    s = htmlmod.escape(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', s)
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', s)

    # Bare URLs, linked outside code spans only.
    #
    # The lookbehind cannot simply exclude '>', because by this point a URL in
    # bold is preceded by the '>' of <strong> - which is exactly the case that
    # must still match. Splitting on code spans is what keeps a URL inside
    # backticks out of an anchor.
    parts = re.split(r'(<code>.*?</code>|<a href=".*?</a>)', s)
    for index, part in enumerate(parts):
        if part.startswith('<code>') or part.startswith('<a href='):
            continue
        parts[index] = re.sub(r'(?<!["\w])(https?://[^\s<)]+)',
                              r'<a href="\1">\1</a>', part)
    return ''.join(parts)


lines = text.split('\n')
out = []
i = 0
while i < len(lines):
    line = lines[i]

    if line.startswith('```'):
        block = []
        i += 1
        while i < len(lines) and not lines[i].startswith('```'):
            block.append(htmlmod.escape(lines[i]))
            i += 1
        i += 1
        out.append('<pre><code>' + '\n'.join(block) + '</code></pre>')
        continue

    if re.match(r'^\s*---\s*$', line):
        out.append('<hr>')
        i += 1
        continue

    m = re.match(r'^(#{1,4})\s+(.*)$', line)
    if m:
        level = len(m.group(1))
        out.append('<h%d>%s</h%d>' % (level, inline(m.group(2)), level))
        i += 1
        continue

    # A table: header row, separator, then body rows.
    if line.strip().startswith('|') and i + 1 < len(lines) and re.match(
            r'^\s*\|[\s:\-|]+\|\s*$', lines[i + 1]):
        def cells(row):
            return [c.strip() for c in row.strip().strip('|').split('|')]

        head = cells(line)
        i += 2
        body = []
        while i < len(lines) and lines[i].strip().startswith('|'):
            body.append(cells(lines[i]))
            i += 1
        out.append('<table><thead><tr>' +
                   ''.join('<th>%s</th>' % inline(c) for c in head) +
                   '</tr></thead><tbody>')
        for row in body:
            out.append('<tr>' + ''.join('<td>%s</td>' % inline(c) for c in row) + '</tr>')
        out.append('</tbody></table>')
        continue

    if re.match(r'^\s*[-*]\s+', line):
        items = []
        while i < len(lines) and re.match(r'^\s*[-*]\s+', lines[i]):
            item = re.sub(r'^\s*[-*]\s+', '', lines[i])
            i += 1
            # Continuation lines of the same bullet.
            while i < len(lines) and lines[i].startswith('  ') and lines[i].strip() \
                    and not re.match(r'^\s*[-*]\s+', lines[i]):
                item += ' ' + lines[i].strip()
                i += 1
            items.append(item)
        out.append('<ul>' + ''.join('<li>%s</li>' % inline(x) for x in items) + '</ul>')
        continue

    if not line.strip():
        i += 1
        continue

    para = [line]
    i += 1
    while i < len(lines) and lines[i].strip() and not re.match(
            r'^(#{1,4}\s|\s*[-*]\s|\s*\||```|\s*---\s*$)', lines[i]):
        para.append(lines[i])
        i += 1
    out.append('<p>%s</p>' % inline(' '.join(x.strip() for x in para)))

body_html = '\n'.join(out)

CSS = """
@page { size: A4; margin: 18mm 16mm 16mm; }
* { box-sizing: border-box; }
body {
  font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  font-size: 10.5pt; line-height: 1.55; color: #0B1F33; margin: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1, h2, h3, h4 { font-family: "IBM Plex Serif", Georgia, serif; line-height: 1.25; }
h1 { font-size: 20pt; margin: 0 0 4pt; }
h2 {
  font-size: 14pt; margin: 20pt 0 6pt; padding-bottom: 4pt;
  border-bottom: 2px solid #0D9488; color: #0B1F33;
  break-after: avoid;
}
h3 { font-size: 11.5pt; margin: 14pt 0 4pt; color: #0D9488; break-after: avoid; }
p { margin: 0 0 7pt; }
hr { border: 0; border-top: 1px solid #E2E8F0; margin: 14pt 0; }
a { color: #0F766E; text-decoration: none; word-break: break-all; }
strong { color: #0B1F33; }
code {
  font-family: "IBM Plex Mono", Consolas, monospace; font-size: 9pt;
  background: #F1F5F9; padding: 1pt 3pt; border-radius: 3px;
  /* A code span moves to the next line whole; only a token too long for one
     line breaks at all. break-all split `send_batches` across two lines. */
  overflow-wrap: anywhere;
}
pre {
  background: #F8FAFC; border: 1px solid #E2E8F0; border-left: 3px solid #0D9488;
  padding: 7pt 9pt; border-radius: 4px; overflow-wrap: anywhere; white-space: pre-wrap;
  margin: 0 0 8pt;
}
pre code { background: none; padding: 0; font-size: 8.5pt; }
table {
  width: 100%; border-collapse: collapse; margin: 0 0 9pt; font-size: 9.5pt;
  break-inside: avoid;
}
th {
  background: #0B1F33; color: #fff; text-align: left; padding: 5pt 7pt;
  font-weight: 600; font-size: 9pt;
}
td { padding: 5pt 7pt; border-bottom: 1px solid #E2E8F0; vertical-align: top; }
tbody tr:nth-child(even) { background: #F8FAFC; }
ul { margin: 0 0 8pt; padding-left: 16pt; }
li { margin-bottom: 3pt; }
"""

page = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<title>Growth Engineer build task \u2014 Fady Masoud</title>'
    '<style>' + CSS + '</style></head><body>' + body_html + '</body></html>'
)

io.open(OUT, 'w', encoding='utf-8', newline='').write(page)
print('wrote', OUT, len(page), 'bytes')
print('what-done-means removed:', 'what done means' not in page)
