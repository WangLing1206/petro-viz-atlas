#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
案例封面图生成（开发期工具）
------------------------------------------------
每个案例一张图，画面必须包含该案例的核心元素：
  · 落物打捞工具智能选型 → 打捞工具矩阵 + 工具匹配表
  · 修井周期预测 → 工序甘特条 + 工期区间 + 蒙特卡洛分布
  · 抽油机井工况诊断 → 多幅示功图 + 工况标注
  · 管道泄漏 → 管道走向图 + 压力曲线 + 报警点
  ...

统一要求：16:9、2K、低饱和青灰/黄铜色调、无人物、屏幕内容为抽象曲线/图形。

用法：
    python tools/gen-case-covers.py
    python tools/gen-case-covers.py --force
    python tools/gen-case-covers.py fishing-tool-kg workover-duration-ts

输出：
    assets/field/covers/<case-id>.jpg
    assets/field/hero.jpg
    assets/field/generation.json
    assets/field/_covers_raw/<key>.png（可删）

API Key 从 ../key.txt 或当前目录 key.txt 读取，不写入站点。
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
API = 'https://api.agnes-ai.cn/v1/images/generations'
MODEL = 'agnes-image-2.5-flash'

STYLE = ('工业可视化摄影，中国油田现场，低饱和青灰色与黄铜色调，写实质感，16:9 横构图，'
         '画面中没有人物、人影、人脸、手或身体部位；屏幕内容只表现抽象曲线、图形、矩阵、'
         '甘特条与色块，不要出现可辨认的文字、数字、标识、水印、品牌 logo。')

COVERS = {
    'welllog-layer':
        '油田测井解释工作站，两块并排显示器：左屏是多条彩色测井曲线（自然电位、电阻率、密度）'
        '与水平分层界线，右屏是井筒剖面和多个标志层；桌面摊着纸质测井图、比例尺和铅笔。',
    'casing-damage-cv':
        '油田测井仪器工作台，一台多臂井径测井仪器特写，金属测量臂呈伞状展开，仪器立在支架上；'
        '旁边显示器显示套管成像展开图与红色损伤段标注；背景是工具架与测井电缆。',
    'fishing-tool-kg':
        '修井工具库房工作台，卡瓦打捞筒、母锥、公锥、篮式捞筒、磨鞋等打捞工具按 4×3 矩阵'
        '整齐排列；旁边笔记本电脑显示工具匹配矩阵（方格与高亮格），桌面有记录板、卡尺和井身结构图。',
    'frac-optimize-opt':
        '压裂设计工作室，双屏工作站：左屏是排量、砂比、液量三条参数曲线，右屏是 Pareto 前沿'
        '散点与方案对比网格；桌上放着压裂设计图纸；窗外是红色压裂泵车组和高压管汇。',
    'gaslogging-fluid-ts':
        '综合录井房内部，一组屏幕显示气测全烃曲线、组分比值和 Pixler 图版（两条交叉曲线），'
        '旁边是气相色谱仪、脱气器和录井设备机柜。',
    'pipeline-leak-ts':
        '输油管道调度中心，巨大的弧形调度大屏：左侧是长输管道走向地图与阀室节点，右侧是'
        '首末站压力曲线、流量平衡曲线和红色泄漏报警点；前方是 SCADA 控制台与键盘。',
    'pump-diagnosis-cv':
        '采油厂监控中心大屏，屏幕上排列六幅抽油机示功图（载荷—位移闭合曲线），用不同颜色'
        '标注正常、供液不足、气影响、泵漏失等工况；屏幕角落是抽油机井现场画面；前方控制台。',
    'workover-duration-ts':
        '修井生产调度室，整面墙的排班板：多条横向甘特条表示七道修井工序，条上标出 P50/P80 '
        '工期区间，右侧是蒙特卡洛概率分布曲线；桌上有一叠作业日报和计算器；窗外是修井井架。',
    'workover-plan-kg':
        '修井方案编制室，墙上大屏显示知识图谱：四列节点（故障现象、工艺、工具、效果）由'
        '连线连接，部分节点高亮；桌上摊开井史、作业总结和工具手册，旁边笔记本电脑显示'
        '相似案例列表；窗外是修井现场。',
    'workover-risk-ts':
        '修井现场值班房，监控屏幕显示立压、套压、排量三条实时曲线，其中一条曲线出现尖峰'
        '并触发红色阈值线与报警标记；旁边是修井机仪表盘和对讲机；窗外是修井井架与井口。',
}

HERO_PROMPT = ('油田智能化调度中心的宽幅场景，多块屏幕分别显示测井曲线、示功图、管道走向图、'
               '打捞工具矩阵、修井甘特图和压力曲线；深色控制台、键盘与图纸；电影感，'
               '无人物，屏幕只有抽象曲线与图形。')


def read_key():
    for p in [ROOT.parent / 'key.txt', Path.cwd() / 'key.txt', ROOT / 'key.txt']:
        if p.exists():
            s = p.read_text(encoding='utf-8').strip()
            if s:
                return s
    raise SystemExit('找不到 key.txt')


def api_call(key, prompt):
    body = {
        'model': MODEL,
        'prompt': STYLE + prompt,
        'size': '2K',
        'ratio': '16:9',
        'extra_body': {'response_format': 'url'},
    }
    req = urllib.request.Request(
        API, data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=360) as r:
        return json.loads(r.read())


def download(url, out):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=240) as r:
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
    for attempt in range(3):
        try:
            t = time.time()
            j = api_call(key, prompt)
            item = (j.get('data') or [{}])[0]
            if item.get('b64_json'):
                raw.write_bytes(base64.b64decode(item['b64_json']))
            elif item.get('url'):
                download(item['url'], raw)
            else:
                raise RuntimeError('响应里没有 url / b64_json')
            process(raw, out)
            rec = {
                'model': MODEL,
                'prompt': STYLE + prompt,
                'task_id': j.get('task_id', ''),
                'source_url': item.get('url', ''),
                'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            }
            print('%-24s OK  %.1fs  %d KB' % (name, time.time() - t, out.stat().st_size // 1024))
            return rec
        except Exception as e:
            print('%-24s 第 %d 次失败：%s' % (name, attempt + 1, str(e)[:180]))
            time.sleep(3)
    return None


def main():
    force = '--force' in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    records = {}
    if GEN.exists():
        try:
            records = json.loads(GEN.read_text(encoding='utf-8'))
        except Exception:
            records = {}

    key = read_key()
    tasks = [(name, prompt, OUT / (name + '.jpg')) for name, prompt in COVERS.items()]
    tasks.append(('hero', HERO_PROMPT, HERO))
    if only:
        tasks = [t for t in tasks if t[0] in only]

    failures = []
    for i, (name, prompt, out) in enumerate(tasks, 1):
        if out.exists() and not force:
            print('[%d/%d] %-24s 已存在，跳过' % (i, len(tasks), name))
            continue
        rec = generate(key, name, prompt, out)
        if rec:
            records[name] = rec
        else:
            failures.append(name)
        time.sleep(1)

    GEN.write_text(json.dumps(records, ensure_ascii=False, indent=1), encoding='utf-8')
    print('\n完成', len(tasks) - len(failures), '/', len(tasks), '失败：', failures or '无')


if __name__ == '__main__':
    main()
