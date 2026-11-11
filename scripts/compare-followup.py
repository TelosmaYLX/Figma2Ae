from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageChops
root=Path(__file__).resolve().parents[1]
folder=root/'artifacts/fidelity'
renders=[Image.open(folder/'after.png').convert('RGB'),Image.open(folder/'final.png').convert('RGB'),Image.open(root/'SampleProject/pinball_game_container.png').convert('RGB')]
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',20)
labels=['本轮修复前','本轮修复后 · AE','Figma 原稿']
width,height=renders[0].size
sheet=Image.new('RGB',(width*3,height+38),'white')
draw=ImageDraw.Draw(sheet)
for col,(label,im) in enumerate(zip(labels,renders)):
    draw.text((col*width+12,5),label,font=font,fill='#26313b')
    sheet.paste(im,(col*width,38))
sheet.save(folder/'comparison-final.png')
details=Image.new('RGB',(1080,720),'#eeeeee')
draw=ImageDraw.Draw(details)
for col,label in enumerate(labels):draw.text((col*360+10,5),label,font=font,fill='#26313b')
for row,(box,scale) in enumerate([((132,73,468,106),1),((698,348,806,455),3),((460,931,535,1018),3)]):
    y=[44,115,460][row]
    for col,im in enumerate(renders):
        crop=im.crop(box)
        crop=crop.resize((crop.width*scale,crop.height*scale))
        details.paste(crop,(col*360+(360-crop.width)//2,y))
details.save(folder/'details-final.png')
ImageChops.difference(renders[1],renders[2]).save(folder/'difference-final.png')
print('Saved full and detail comparisons')
