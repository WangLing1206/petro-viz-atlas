#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Case cover generation, English-prompt edition v3: DIRECT-CONTENT style.

Each cover shows the case's own working content filling the frame
(the chart / diagram itself, not a photo of screens):
  dynamometer cards, Gantt bars, knowledge graph, pressure curves,
  log curves, caliper image strip, tool matrix, Pareto scatter,
  crossplot, pipeline route map.

Flat technical-infographic illustration on a light paper background,
dark ink lines, brass/amber accents, one red alarm color where relevant.
No photos, no monitors, no desks, no people, no legible text/numbers/logos.

Usage:
    python tools/gen-case-covers-en.py --force --only pump-diagnosis-cv
"""

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'field' / 'covers'
HERO = ROOT / 'assets' / 'field' / 'hero.jpg'
RAW = ROOT / 'assets' / 'field' / '_covers_raw'
GEN = ROOT / 'assets' / 'field' / 'generation.json'
MODEL = 'agnes-image-2.5-flash'
APIS = [
    'https://apihub.agnes-ai.com/v1/images/generations',
    'https://api.agnes-ai.cn/v1/images/generations',
]

STYLE = (
    'Flat technical-infographic illustration, 16:9 horizontal composition, '
    'the diagram itself fills the entire frame edge to edge. Light warm-paper '
    'background (#F5EFE2), dark petrol-ink lines (#0E3A3E), brass and amber '
    'accents (#B07A2A, #D9B679), one signal-red (#A64B3C) reserved for alarms '
    'and damage marks only. Crisp vector look, fine grid lines, high visual '
    'density, generous margins, balanced layout. Absolutely no photographs, '
    'no monitors, no desks, no rooms, no people, no hands, no shadows. '
    'No legible text, no numbers, no letters, no logos, no watermarks.'
)

COVERS = {
    'welllog-layer':
        'Wireline well-log chart: four vertical track columns of colorful '
        'wiggling log curves in teal, brass, ochre and slate, crossed by bold '
        'horizontal stratigraphic boundary lines dividing eight stacked layer '
        'bands; a slim depth track on the left, a narrow wellbore strip with '
        'alternating shaded beds on the right.',

    'casing-damage-cv':
        'Casing-inspection diagram: a circular multi-arm caliper cross-section '
        'with sixteen thin measuring arms radiating outward on the left, and a '
        'long unwrapped casing-imaging strip on the right built from fine scan '
        'lines, with two jagged signal-red bands marking damaged intervals.',

    'fishing-tool-kg':
        'Fishing-tool selection matrix: a four-by-three grid of distinct dark '
        'steel downhole-tool silhouettes (overshots, taper taps, spears, mills) '
        'on paper cards, exactly one card highlighted with a brass frame and a '
        'check mark, thin connector lines linking the grid to a small wellbore '
        'icon with a stuck fish shape.',

    'frac-optimize-opt':
        'Fracturing-optimization dashboard graphic: three smooth pumping-parameter '
        'curves (rate, sand ratio, fluid volume) stacked on the upper half, a '
        'Pareto-frontier scatter of dots with one brass star optimum below, '
        'and a row of horizontal design-comparison bars along the bottom.',

    'gaslogging-fluid-ts':
        'Mud-gas interpretation plate: a tall total-hydrocarbon spiking curve on '
        'the left, a set of vertical component-ratio bars in the middle, and a '
        'crossplot panel on the right where two smooth curves intersect inside '
        'a triangular fluid-zone envelope.',

    'pipeline-leak-ts':
        'Pipeline leak-detection graphic: a long horizontal pipeline route line '
        'with round valve-station nodes across the upper third, two declining '
        'pressure curves beneath it, one glowing signal-red alarm pin dropped '
        'exactly where the curves diverge, with faint concentric alert rings.',

    'pump-diagnosis-cv':
        'Six sucker-rod pump dynamometer cards (closed load-versus-displacement '
        'loops) arranged in a two-by-three grid, each loop a different '
        'condition color in teal, brass, ochre, slate and red; the bottom-right '
        'loop circled by a signal-red dashed ring as the anomaly.',

    'workover-duration-ts':
        'Workover-schedule Gantt graphic: seven horizontal progress bars in a '
        'left list, each bar carrying a shaded P50-to-P80 duration band with a '
        'diamond milestone, and a smooth bell-shaped probability-distribution '
        'curve occupying the right third of the frame.',

    'workover-plan-kg':
        'Knowledge-graph diagram: four vertical columns of round nodes '
        '(symptoms, processes, tools, outcomes) linked by curved edges, one '
        'reasoning path from left to right highlighted in glowing brass with '
        'enlarged nodes, the rest in muted ink outlines.',

    'workover-risk-ts':
        'Real-time risk-monitor graphic: three jagged monitoring curves '
        '(pressure, pressure, flow rate) running left to right, one curve '
        'spiking sharply through a horizontal signal-red threshold line, '
        'a bold alarm badge bursting at the crossing point, small gauge dials '
        'tucked in the lower corners.',
}

HERO_PROMPT = (
    'Panoramic intelligent-oilfield dispatch center: a wall of screens showing '
    'wireline log curves, dynamometer cards, a pipeline route map, '
    'a fishing-tool matrix, a workover Gantt chart and pressure curves; '
    'dark consoles, keyboards and rolled drawings in front, cinematic depth, '
    'no people, screens hold abstract curves and graphics only.'
)


def read_key():
    for p in [ROOT.parent / 'key.txt', Path.cwd() / 'key.txt', ROOT / 'key.txt']:
        if p.exists():
            s = p.read_text(encoding='utf-8').strip()
            if s:
                return s
    raise SystemExit('key.txt not found')


def api_call(key, prompt):
    body = {
        'model': MODEL,
        'prompt': STYLE + ' ' + prompt,
        'size': '2K',
        'ratio': '16:9',
        'extra_body': {'response_format': 'url'},
    }
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    last = None
    for api in APIS:
        try:
            req = urllib.request.Request(
                api, data=data,
                headers={'Authorization': 'Bearer ' + key,
                         'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=150) as r:
                return json.loads(r.read())
        except Exception as e:
            last = e
            print('endpoint %s failed: %s' % (api, str(e)[:120]), flush=True)
    raise RuntimeError('all endpoints failed: %s' % str(last)[:200])


def download(url, out):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        out.write_bytes(r.read())


def process(raw_path, out_path):
    im = Image.open(raw_path).convert('RGB')
    w, h = im.size
    target = 1280 / 720
    if w / h > target:
        nw = int(h * target)
        im = im.crop(((w - nw) // 2, 0, (w + nw) // 2, h))
    elif w / h < target:
        nh = int(w / target)
        im = im.crop((0, (h - nh) // 2, w, (h + nh) // 2))
    im.resize((1280, 720), Image.LANCZOS).save(
        out_path, 'JPEG', quality=84, optimize=True, progressive=True)


def generate(key, name, prompt, out):
    raw = RAW / (name + '.png')
    for attempt in range(4):
        try:
            t = time.time()
            j = api_call(key, prompt)
            item = (j.get('data') or [{}])[0]
            if item.get('b64_json'):
                raw.write_bytes(base64.b64decode(item['b64_json']))
            elif item.get('url'):
                download(item['url'], raw)
            else:
                raise RuntimeError('no url / b64_json in response: '
                                   + json.dumps(j)[:200])
            process(raw, out)
            rec = {
                'model': MODEL,
                'prompt': STYLE + ' ' + prompt,
                'task_id': j.get('task_id', ''),
                'source_url': item.get('url', ''),
                'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            }
            print('%-24s OK  %.1fs  %d KB'
                  % (name, time.time() - t, out.stat().st_size // 1024),
                  flush=True)
            return rec
        except Exception as e:
            print('%-24s attempt %d failed: %s'
                  % (name, attempt + 1, str(e)[:180]), flush=True)
            time.sleep(5)
    return None


def main():
    force = '--force' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if '--only' in sys.argv:
        i = sys.argv.index('--only')
        only = sys.argv[i + 1].split(',')
    else:
        only = args
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    records = {}
    if GEN.exists():
        try:
            records = json.loads(GEN.read_text(encoding='utf-8'))
        except Exception:
            records = {}

    key = read_key()
    tasks = [(name, prompt, OUT / (name + '.jpg'))
             for name, prompt in COVERS.items()]
    tasks.append(('hero', HERO_PROMPT, HERO))
    if only:
        tasks = [t for t in tasks if t[0] in only]

    failures = []
    for i, (name, prompt, out) in enumerate(tasks, 1):
        if out.exists() and not force:
            print('[%d/%d] %-24s exists, skip' % (i, len(tasks), name),
                  flush=True)
            continue
        rec = generate(key, name, prompt, out)
        if rec:
            records[name] = rec
        else:
            failures.append(name)
        time.sleep(2)

    GEN.write_text(json.dumps(records, ensure_ascii=False, indent=1),
                   encoding='utf-8')
    print('\ndone %d/%d failures: %s'
          % (len(tasks) - len(failures), len(tasks), failures or 'none'))


if __name__ == '__main__':
    main()
