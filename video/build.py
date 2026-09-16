"""
QuietBooks demo video — built in the exact style of LIFTWITHOG (OGT).
Every frame is a composition of real app footage and terminal output,
laid on a technical brand background with headline, subtitle, brand bar, and edge-tts narration.
"""
import json, os, subprocess, sys, math, shutil, textwrap
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'shots')
OUT = os.path.join(HERE, 'out'); os.makedirs(OUT, exist_ok=True)
SCENES = json.load(open(os.path.join(HERE, 'scenes.json'), encoding='utf-8'))
FONT = os.path.join(HERE, 'fonts', 'InstrumentSans.ttf')
MONO = r'C:\Windows\Fonts\consola.ttf'
MARK = os.path.join(HERE, 'icon.png')

W, H = 1920, 1080

# QuietBooks refined dark technical palette
PAPER = (12, 16, 24)       # Deep Midnight ground
INK = (245, 247, 250)       # Crisp white/silver text
DIM = (142, 153, 168)       # Slate muted label
ACCENT = (126, 160, 232)    # Midnight blue glow / accent line
GREEN = (108, 187, 142)     # Emerald proof ok

VOICE = 'en-US-JennyNeural' # High quality crisp neural voice
TTS = True

def font(size, weight='Regular'):
    f = ImageFont.truetype(FONT, size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

def wrap(draw, text, f, maxw):
    lines = []
    for para in text.split('\n'):
        cur = ''
        for word in para.split(' '):
            trial = (cur + ' ' + word).strip()
            if draw.textlength(trial, font=f) <= maxw: cur = trial
            else: lines.append(cur); cur = word
        lines.append(cur)
    return lines

def browser_window(path, width=1050):
    im = Image.open(path).convert('RGB')
    scale = width / im.width
    height = round(im.height * scale)
    im = im.resize((width, height), Image.LANCZOS)
    
    r = 16; header_h = 36
    w, h = width, height + header_h
    body = Image.new('RGBA', (w, h), (18, 24, 38, 255))
    d = ImageDraw.Draw(body)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=(18, 24, 38, 255), outline=(42, 54, 82), width=2)
    
    # 3 window buttons
    for i, c in enumerate([(235, 95, 86), (235, 189, 46), (56, 195, 110)]):
        d.ellipse([18 + i * 22, 12, 28 + i * 22, 22], fill=c)
        
    # URL bar mockup
    d.rounded_rectangle([100, 8, w - 30, 28], radius=6, fill=(10, 14, 22), outline=(32, 42, 65))
    d.text((115, 11), 'quietbooks.network · Midnight Lace Connected', font=ImageFont.truetype(MONO, 12), fill=(126, 160, 232))

    # Paste screenshot inside
    body.paste(im, (0, header_h))
    
    # Soft shadow
    sh = Image.new('RGBA', (w + 140, h + 140), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([70, 85, 70 + w, 85 + h], radius=r + 8, fill=(0, 0, 0, 90))
    sh = sh.filter(ImageFilter.GaussianBlur(32))
    sh.alpha_composite(body, (70, 70))
    return sh

def text_block(draw, x, y, headline, sub, maxw=650):
    hf = font(64, 'Bold'); sf = font(26, 'Medium')
    yy = y
    for line in wrap(draw, headline, hf, maxw):
        draw.text((x, yy), line, font=hf, fill=INK); yy += 78
    yy += 14
    draw.rounded_rectangle([x, yy, x + 90, yy + 5], radius=3, fill=ACCENT); yy += 34
    for line in wrap(draw, sub, sf, maxw):
        draw.text((x, yy), line, font=sf, fill=DIM); yy += 38

def wordmark(d):
    f = font(22, 'Bold')
    d.text((120, H - 75), 'QuietBooks', font=f, fill=INK)
    d.text((120 + d.textlength('QuietBooks', font=f) + 12, H - 75), '·  Private B2B Invoicing & Settlement  ·  on Midnight', font=font(20, 'Medium'), fill=DIM)

def frame_app(shot, headline, sub, out):
    canvas = Image.new('RGB', (W, H), PAPER)
    card = browser_window(shot)
    canvas.paste(card, (W - card.width - 60, (H - card.height) // 2), card)
    d = ImageDraw.Draw(canvas)
    text_block(d, 120, 310, headline, sub)
    wordmark(d)
    canvas.save(out)

def frame_title(headline, sub, out, url=None):
    canvas = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(canvas)
    if os.path.exists(MARK):
        mark = Image.open(MARK).convert('RGBA').resize((160, 160), Image.LANCZOS)
        canvas.paste(mark, ((W - 160) // 2, 260), mark)
    hf = font(76, 'Bold'); sf = font(32, 'Medium')
    y = 470
    for line in wrap(d, headline, hf, 1500):
        d.text(((W - d.textlength(line, font=hf)) // 2, y), line, font=hf, fill=INK); y += 92
    d.rounded_rectangle([(W - 90) // 2, y + 14, (W + 90) // 2, y + 20], radius=3, fill=ACCENT); y += 52
    for line in wrap(d, sub, sf, 1500):
        d.text(((W - d.textlength(line, font=sf)) // 2, y), line, font=sf, fill=DIM); y += 46
    if url:
        uf = font(38, 'SemiBold'); y += 28
        d.text(((W - d.textlength(url, font=uf)) // 2, y), url, font=uf, fill=GREEN)
    canvas.save(out)

def frame_terminal(lines, headline, sub, out):
    canvas = Image.new('RGB', (W, H), PAPER)
    d = ImageDraw.Draw(canvas)
    text_block(d, 120, 310, headline, sub, maxw=680)
    
    card_w, card_h = 960, 560
    card = Image.new('RGBA', (card_w, card_h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cd.rounded_rectangle([0, 0, card_w - 1, card_h - 1], radius=20, fill=(10, 13, 20, 255), outline=(35, 45, 68), width=2)
    
    for i, c in enumerate([(235, 95, 86), (235, 189, 46), (56, 195, 110)]):
        cd.ellipse([24 + i * 26, 20, 38 + i * 26, 34], fill=c)
    cd.text((115, 20), 'bash - quietbooks verification suite', font=ImageFont.truetype(MONO, 13), fill=(126, 160, 232))
    
    mf = ImageFont.truetype(MONO, 21)
    y = 80
    for i, line in enumerate(lines):
        if i == 0:
            for sub_line in textwrap.wrap(line, 68):
                cd.text((36, y), sub_line, font=mf, fill=(108, 187, 142)); y += 34
            y += 14
        else:
            name, _, val = line.rpartition(':')
            cd.text((36, y), name + ':', font=mf, fill=(200, 210, 225))
            cd.text((36 + cd.textlength(name + ':', font=mf), y), val, font=mf, fill=(108, 187, 142)); y += 36
            
    canvas.paste(card, (W - card_w - 80, (H - card_h) // 2), card)
    wordmark(d)
    canvas.save(out)

def shot_path(name):
    return os.path.join(SHOTS, name)

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(r.stderr[-1500:]); raise SystemExit(cmd[0] + ' failed')
    return r

def duration(path):
    return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).stdout.strip())

# ---- 1. Voice generation (edge-tts) -----------------------------------------
print('Generating TTS voiceover clips...')
timeline = []
srt = []; t = 0.0
PAD = 0.85

for sc in SCENES:
    vo = os.path.join(OUT, sc['id'] + '.mp3')
    if TTS and not os.path.exists(vo):
        print(f"Generating TTS for scene: {sc['id']}")
        run(['edge-tts', '--voice', VOICE, '--rate=+2%', '--text', sc['vo'], '--write-media', vo])
    d = duration(vo) if os.path.exists(vo) else max(3.5, len(sc['vo']) / 15)
    sc['_dur'] = d + PAD
    
    sents = [s.strip() for s in sc['vo'].replace('? ', '?|').replace('. ', '.|').split('|') if s.strip()]
    total = sum(len(s) for s in sents); tt = t
    for s in sents:
        dd = d * len(s) / total
        srt.append((tt, tt + dd, s)); tt += dd
    sc['_start'] = t
    t += sc['_dur']

def ts(x):
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f'{h:02d}:{m:02d}:{s:06.3f}'.replace('.', ',')

with open(os.path.join(OUT, 'demo.srt'), 'w', encoding='utf-8') as f:
    for i, (a, b, s) in enumerate(srt, 1):
        f.write(f'{i}\n{ts(a)} --> {ts(b)}\n{s}\n\n')

# ---- 2. Compose Frames ------------------------------------------------------
print('Composing scene frames...')
for sc in SCENES:
    kind = sc['kind']
    if kind == 'title':
        p = os.path.join(OUT, sc['id'] + '.png'); frame_title(sc['headline'], sc['sub'], p); timeline.append((p, sc['_dur']))
    elif kind == 'close':
        p = os.path.join(OUT, sc['id'] + '.png'); frame_title(sc['headline'], sc['sub'], p, sc.get('url')); timeline.append((p, sc['_dur']))
    elif kind == 'terminal':
        p = os.path.join(OUT, sc['id'] + '.png'); frame_terminal(sc['terminal'], sc['headline'], sc['sub'], p); timeline.append((p, sc['_dur']))
    elif kind == 'app-shot':
        p = os.path.join(OUT, sc['id'] + '.png'); frame_app(shot_path(sc['shot']), sc['headline'], sc['sub'], p); timeline.append((p, sc['_dur']))

# ---- 3. Render Clips with gentle zoom and cross-fade ------------------------
print('Rendering video clips with motion and transitions...')
FADE = 0.5
clips = []

for i, (png, dur) in enumerate(timeline):
    clip = os.path.join(OUT, f'clip{i:02d}.mp4')
    frames = max(2, round((dur + FADE) * 30))
    zoom = f"zoompan=z='min(zoom+0.00035,1.05)':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps=30"
    print(f"Rendering clip {i+1}/{len(timeline)}: {dur:.1f}s")
    run(['ffmpeg', '-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-vf', zoom, '-t', f'{dur + FADE:.3f}', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', clip])
    clips.append((clip, dur))

inputs = []; filt = ''; offset = 0.0; last = '[0:v]'
for i, (c, d) in enumerate(clips): inputs += ['-i', c]
for i in range(1, len(clips)):
    offset += clips[i - 1][1]
    out_lbl = f'[v{i}]' if i < len(clips) - 1 else '[vout]'
    filt += f"{last}[{i}:v]xfade=transition=fade:duration={FADE}:offset={offset:.3f}{out_lbl};"
    last = out_lbl

filt = filt.rstrip(';')
video = os.path.join(OUT, 'video.mp4')
print('Fading and assembling video track...')
run(['ffmpeg', '-loglevel', 'error', '-y', *inputs, '-filter_complex', filt, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', video])

# ---- 4. Audio Mixing --------------------------------------------------------
print('Assembling narration audio track...')
total = sum(d for _, d in clips) + FADE
ain = []; af = ''
for i, sc in enumerate(SCENES):
    vo = os.path.join(OUT, sc['id'] + '.mp3')
    if not os.path.exists(vo): continue
    ain += ['-i', vo]
    af += f"[{len(ain)//2 - 1}:a]adelay={int((sc['_start'] + 0.3) * 1000)}|{int((sc['_start'] + 0.3) * 1000)}[a{i}];"

n = len(ain) // 2
if n:
    af += ''.join(f'[a{i}]' for i in range(len(SCENES)) if os.path.exists(os.path.join(OUT, SCENES[i]['id'] + '.mp3')))
    af += f'amix=inputs={n}:normalize=0,apad=whole_dur={total:.3f}[aout]'
    audio = os.path.join(OUT, 'audio.m4a')
    run(['ffmpeg', '-loglevel', 'error', '-y', *ain, '-filter_complex', af, '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-t', f'{total:.3f}', audio])
else:
    audio = None

# ---- 5. Mux with burned captions --------------------------------------------
print('Muxing final video with styled subtitles...')
final = os.path.join(HERE, 'quietbooks-demo.mp4')
esc = lambda s: s.replace('\\', '/').replace(':', '\\:').replace(',', '\\,')
srt_path = esc(os.path.join(OUT, 'demo.srt'))
fonts_dir = esc(os.path.join(HERE, 'fonts'))

style = esc("FontName=Instrument Sans,FontSize=15,PrimaryColour=&H00F5F7FA,OutlineColour=&H000C1018,BorderStyle=4,BackColour=&H900C1018,Outline=0,Shadow=0,MarginL=32,MarginR=150,MarginV=38,Alignment=1")
vf = f"subtitles='{srt_path}':fontsdir='{fonts_dir}':force_style='{style}'"

cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-i', video]
if audio: cmd += ['-i', audio]
cmd += ['-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']
if audio: cmd += ['-c:a', 'copy', '-shortest']
cmd += [final]

run(cmd)

# Also copy to docs/
docs_final = r"C:\Users\ritik\midnight\quietbooks\docs\quietbooks-demo-presentation.mp4"
shutil.copy(final, docs_final)

print('SUCCESS!')
print(f'Final Video: {final}')
print(f'Duration: {duration(final):.1f}s')
