(function(){
  var prev=app.project.activeItem,comp=null;
  app.beginUndoGroup('F2A punctuation regression');
  try{
    $.evalFile(F2A_ROOT+'/host/figma/aeShapeBuilder.jsx');
    comp=app.project.items.addComp('F2A punctuation test',832,180,1,1,30);comp.openInViewer();
    var text={characters:'收集赛事卡牌，兑换电竞补给箱 !',fontSize:21.33333396911621,family:'Source Han Sans CN',style:'Medium',color:[0.2,0.243,0.282],align:'CENTER',tracking:0,x:23,y:73.96083,w:556,h:34,ink:{x:146.915909,y:80.870163,w:307.469025,h:20.650665}};
    AEShapeBuilder.buildText(comp,[text]);
    var layer=comp.layer(1),rect=layer.sourceRectAtTime(0,false);
    if(Math.abs(rect.width-text.ink.w)>0.15)throw new Error('Subtitle width mismatch: '+rect.width);
    var doc=layer.property('ADBE Text Properties').property('ADBE Text Document').value;
    if(doc.characterRange(6,7).autoKernType!==AutoKernType.NO_AUTO_KERN)throw new Error('Full-width comma was compressed');
    if(doc.characterRange(0,1).autoKernType!==AutoKernType.METRIC_KERN)throw new Error('Unrelated character kerning changed');
    var rich={runs:true,align:text.align,x:text.x,y:text.y,w:text.w,h:text.h,ink:text.ink,segs:[]};
    var chars=[text.characters.substring(0,6),text.characters.substring(6)];
    for(var i=0;i<chars.length;i++)rich.segs.push({characters:chars[i],family:text.family,style:text.style,fontSize:text.fontSize,color:text.color,tracking:0,opacity:1});
    AEShapeBuilder.buildText(comp,[rich]);
    var richWidth=comp.layer(1).sourceRectAtTime(0,false).width;
    if(Math.abs(richWidth-text.ink.w)>0.15)throw new Error('Rich subtitle width mismatch: '+richWidth);
    rich.stroke={color:[1,1,1],width:4/3,align:'OUTSIDE'};
    AEShapeBuilder.buildText(comp,[rich]);
    var stroked=comp.layer(1).property('ADBE Text Properties').property('ADBE Text Document').value;
    var style=comp.layer(1).property('ADBE Layer Styles').property('frameFX/enabled');
    if(stroked.applyStroke || !style.enabled || style.property('frameFX/style').value!==1 || Math.abs(style.property('frameFX/size').value-4/3)>0.01)throw new Error('Editable outside text Layer Style stroke missing');
    return JSON.stringify({passed:true,subtitleWidth:rect.width,richSubtitleWidth:richWidth,figmaWidth:text.ink.w,outsideTextStroke:true});
  }catch(e){return JSON.stringify({passed:false,error:e.toString(),line:e.line});}
  finally{if(comp)comp.remove();if(prev&&prev.openInViewer)prev.openInViewer();app.endUndoGroup();}
})();
