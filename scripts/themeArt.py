"""Generates the decorative SVGs in public/themes/. Seeded, so reruns reproduce the committed art exactly."""
import math, random
from pathlib import Path
OUT = Path(__file__).parent.parent / "public" / "themes"
random.seed(7)

def rocks(width=1600, height=340):
    layers=[("#0b100c",0.0,140),("#111a12",0.35,200),("#17241a",0.7,260)]
    out=""
    for colour,phase,base in reversed(layers):
        pts=[]; x=0
        while x<=width:
            y=height-base+60*math.sin(x/170+phase*9)+35*math.sin(x/53+phase*4)+random.uniform(-14,14)
            pts.append((x,y)); x+=random.uniform(18,46)
        pts.append((width,height)); pts.insert(0,(0,height))
        out+=f'<path fill="{colour}" d="M{" L".join(f"{a:.0f},{b:.0f}" for a,b in pts)} L{width},{height} Z"/>'
    # stalactite-ish moss glints
    for _ in range(60):
        x=random.uniform(0,width); y=height-random.uniform(60,200)
        out+=f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{random.uniform(1,2.4):.1f}" fill="#7fe0c0" opacity="{random.uniform(0.15,0.5):.2f}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" preserveAspectRatio="none">{out}</svg>'

def parchment():
    return '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><filter id="p"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="4" seed="3"/><feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.33  0 0 0 0 0.16  0 0 0 0.35 0"/></filter><rect width="600" height="600" filter="url(#p)"/></svg>'

def vine_border():
    # 9-slice: 150x150, slice 44. Gilt double rule with leafy vine and corner knots.
    g="#a8812f"; leaf="#5d7a35"
    corner=lambda tx,ty,r: f'<g transform="translate({tx},{ty}) rotate({r})"><circle cx="22" cy="22" r="13" fill="none" stroke="{g}" stroke-width="2.5"/><circle cx="22" cy="22" r="5" fill="{g}"/><path d="M22,9 C30,0 40,4 44,10 M9,22 C0,30 4,40 10,44" stroke="{leaf}" stroke-width="2" fill="none"/><path d="M36,6 q6,-4 10,2 q-6,4 -10,-2Z M6,36 q-4,6 2,10 q4,-6 -2,-10Z" fill="{leaf}"/></g>'
    edge=""
    for i in range(4):
        # leaves along top/bottom/left/right in the middle segment (44..106)
        for k,t in enumerate(range(52,104,13)):
            flip = -1 if k%2 else 1
            edge+=f'<path d="M{t},11 q4,{-6*flip} 9,0 q-4,{6*flip} -9,0Z" fill="{leaf}" transform="rotate({90*i} 75 75)"/>'
        edge+=f'<path d="M44,11 C60,4 64,18 75,11 S90,4 106,11" stroke="{leaf}" stroke-width="1.6" fill="none" transform="rotate({90*i} 75 75)"/>'
    rules=f'<rect x="3" y="3" width="144" height="144" fill="none" stroke="{g}" stroke-width="2"/><rect x="18" y="18" width="114" height="114" fill="none" stroke="{g}" stroke-width="1"/>'
    corners=corner(0,0,0)+corner(150,0,90)+corner(150,150,180)+corner(0,150,270)
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150">{rules}{edge}{corners}</svg>'

def mushrooms():
    def shroom(x, s, cap, glow):
        return (f'<g transform="translate({x},70) scale({s})">'
                f'<ellipse cx="0" cy="-30" rx="26" ry="20" fill="{glow}" opacity="0.18"/>'
                f'<path d="M-4,0 C-5,-14 -3,-22 -2,-28 L2,-28 C3,-22 5,-14 4,0Z" fill="#e8dcc0"/>'
                f'<path d="M-18,-26 C-16,-42 16,-42 18,-26 C10,-29 -10,-29 -18,-26Z" fill="{cap}"/>'
                f'<circle cx="-7" cy="-34" r="2" fill="#f5ecd2"/><circle cx="5" cy="-36" r="1.6" fill="#f5ecd2"/><circle cx="11" cy="-31" r="1.3" fill="#f5ecd2"/>'
                '</g>')
    body=shroom(30,0.8,"#7a3f2a","#ffb46b")+shroom(58,1.1,"#2f6b5a","#7fe0c0")+shroom(86,0.65,"#7a3f2a","#ffb46b")+shroom(108,0.9,"#4a5f2a","#c4e36b")
    grass="".join(f'<path d="M{x},70 q{random.uniform(-4,4):.1f},-8 {random.uniform(-3,3):.1f},-{random.uniform(8,16):.1f}" stroke="#5d7a35" stroke-width="1.4" fill="none"/>' for x in range(4,136,5))
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="140" height="72" viewBox="0 0 140 72">{body}{grass}</svg>'

for name,content in [("rocks.svg",rocks()),("parchment.svg",parchment()),("vine-border.svg",vine_border()),("mushrooms.svg",mushrooms())]:
    (OUT/name).write_text(content)
    print(name, len(content))
