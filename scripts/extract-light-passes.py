from pathlib import Path
import copy, re
import xml.etree.ElementTree as ET

root=Path(__file__).resolve().parents[1]
out=root/'artifacts/fidelity/light-passes'
out.mkdir(parents=True,exist_ok=True)
ns='http://www.w3.org/2000/svg'
ET.register_namespace('',ns)
ET.register_namespace('xlink','http://www.w3.org/1999/xlink')
doc=ET.parse(root/'SampleProject/pinball_game_container.svg').getroot()
defs={el.get('id'):el for el in doc.find('{'+ns+'}defs') if el.get('id')}
for row in range(4):
    # Resolve each row from its mask's Y coordinate rather than assuming exported IDs.
    y=[348,465.333,582.667,700][row]
    candidates=[]
    for el in doc.iter('{'+ns+'}g'):
        if not el.get('clip-path'):continue
        masks=list(el.findall('{'+ns+'}mask'))
        if any(m.get('x')=='600' and abs(float(m.get('y','-1'))-int(y))<1.1 for m in masks):
            if any('mix-blend-mode:soft-light' in n.get('style','') and n.get('filter') for n in el.iter()):candidates.append(el)
    if not candidates:raise RuntimeError('Light group missing for row '+str(row))
    group=candidates[0]
    overlays=[n for n in group.iter() if 'mix-blend-mode:soft-light' in n.get('style','') and n.get('filter')]
    for kind in ['full','base']+['soft'+str(i) for i in range(len(overlays))]:
        body=copy.deepcopy(group)
        parent={c:p for p in body.iter() for c in p}
        copied=[n for n in body.iter() if 'mix-blend-mode:soft-light' in n.get('style','') and n.get('filter')]
        if kind=='base':
            for n in copied:parent[n].remove(n)
        elif kind.startswith('soft'):
            target=copied[int(kind[4:])]
            target.attrib.pop('style',None)
            cur=target
            while cur is not body:
                p=parent[cur]
                for sibling in list(p):
                    if sibling is not cur and not sibling.tag.endswith('mask'):p.remove(sibling)
                cur=p
        text=ET.tostring(body,encoding='unicode')
        needed=set(re.findall(r'url\(#([^)]*)\)|href="#([^"]*)"',text))
        queue=[a or b for a,b in needed];used={}
        while queue:
            ident=queue.pop()
            if ident in used or ident not in defs:continue
            d=defs[ident];used[ident]=d
            queue.extend(a or b for a,b in re.findall(r'url\(#([^)]*)\)|href="#([^"]*)"',ET.tostring(d,encoding='unicode')))
        height='104.31103515625' if row==3 else '106.66668701171875'
        svg=ET.Element('{'+ns+'}svg',{'width':'411','height':'209' if row==3 else '214','viewBox':f'600 {y} 205.33334350585938 {height}','fill':'none'})
        svgdefs=ET.SubElement(svg,'{'+ns+'}defs')
        for d in used.values():svgdefs.append(copy.deepcopy(d))
        svg.append(body)
        ET.ElementTree(svg).write(out/f'row{row}-{kind}.svg',encoding='utf-8',xml_declaration=True)
    print(row,group.get('clip-path'),'soft-light overlays',len(overlays))
