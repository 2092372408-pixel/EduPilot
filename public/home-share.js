/* Render the selected learning records as a portable, local PNG card. */
(function () {
  'use strict';
  const projectUrl = 'https://github.com/2092372408-pixel/EduPilot';
  const list = value => Array.isArray(value) ? value : [];
  const cleanText = (value, length = 180) => typeof value === 'string'
    ? [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, length).join('') : '';
  const count = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

  function buildSnapshot(data, { courseIds = [], showName = true, lang = 'zh' } = {}) {
    const catalog = new Map();
    for (const course of list(data?.courses)) if (course && typeof course.id === 'string' && !catalog.has(course.id)) catalog.set(course.id, course);
    const ids = [...new Set(list(courseIds))].filter(id => catalog.has(id)).slice(0, 4);
    const courses = ids.map(id => {
      const course = catalog.get(id), totalTopics = count(course.totalTopics);
      const masteredTopics = Math.min(totalTopics, count(course.masteredTopics));
      const studiedTopics = Math.min(totalTopics, Math.max(masteredTopics, count(course.studiedTopics)));
      return { id, title: cleanText(course.title), totalTopics, studiedTopics, masteredTopics,
        progressPercent: totalTopics ? Math.round(masteredTopics * 100 / totalTopics) : 0,
        studiedPercent: totalTopics ? Math.round(studiedTopics * 100 / totalTopics) : 0 };
    });
    const selected = new Map(courses.map(course => [course.id, course]));
    const skills = [], domains = [], seenSkills = new Set(), seenDomains = new Set();
    const selectedDomains = list(data?.domains).filter(domain => domain && selected.has(domain.courseId));
    for (const domain of selectedDomains) {
      for (const skill of list(domain.skills)) {
        if (!skill || skill.mastered !== true || typeof skill.kpId !== 'string' || !skill.kpId || !cleanText(skill.title)) continue;
        const key = JSON.stringify([domain.courseId, skill.kpId]);
        if (seenSkills.has(key)) continue;
        seenSkills.add(key);
        if (skills.length < 8) skills.push({ courseId: domain.courseId, kpId: skill.kpId,
          title: cleanText(skill.title), courseTitle: selected.get(domain.courseId).title });
      }
    }
    for (const domain of selectedDomains) {
      if (domains.length >= Math.min(6, 8 - skills.length)) break;
      const totalTopics = count(domain.totalTopics), studiedTopics = Math.min(totalTopics, count(domain.studiedTopics));
      if (!studiedTopics || count(domain.masteredTopics) >= totalTopics || !cleanText(domain.title) || typeof domain.id !== 'string') continue;
      const key = JSON.stringify([domain.courseId, domain.id]);
      if (seenDomains.has(key)) continue;
      seenDomains.add(key);
      domains.push({ courseId: domain.courseId, id: domain.id, title: cleanText(domain.title),
        courseTitle: selected.get(domain.courseId).title, totalTopics, studiedTopics });
    }
    const summary = courses.reduce((totals, course) => {
      for (const key of ['totalTopics', 'studiedTopics', 'masteredTopics']) totals[key] += course[key];
      return totals;
    }, { courses: courses.length, totalTopics: 0, studiedTopics: 0, masteredTopics: 0 });
    const date = new Date(typeof data?.generatedAt === 'string' ? data.generatedAt : '');
    const snapshot = { version: 1, lang: lang === 'en' ? 'en' : 'zh',
      generatedAt: Number.isFinite(date.getTime()) ? date.toISOString() : '', projectUrl, summary, courses, skills, domains };
    const nickname = cleanText(data?.profile?.nickname, 20);
    if (showName && nickname) snapshot.nickname = nickname;
    return snapshot;
  }

  const words = {
    zh: {
      eyebrow: '我的学习主页', title: '我的学习足迹', named: name => name + '的学习足迹',
      subtitle: '把学过的知识，变成自己的能力。', courses: '精选课程', studied: '已学知识点', mastered: '复习通过',
      courseSection: '持续前进的课程', progress: (done, total) => `已掌握 ${done} / ${total} 个知识点`,
      skillSection: '通过复习验证的知识', domainSection: '学习中的领域',
      emptyCourses: '从一门感兴趣的课程开始。', emptySkills: '每一次练习，都是下一步的起点。',
      footer: '把教材变成课程，把学习积累成成果。', scan: '扫码，一起开始学习',
      imageError: '分享图片资源加载失败，请重试。', canvasError: '暂时无法生成分享图片，请重试。',
    },
    en: {
      eyebrow: 'MY LEARNING HOME', title: 'My learning journey', named: name => name + '\u2019s learning journey',
      subtitle: 'From materials to practice. From practice to progress.', courses: 'Selected courses', studied: 'Concepts studied', mastered: 'Review checks passed',
      courseSection: 'Learning in progress', progress: (done, total) => `${done} / ${total} concepts mastered`,
      skillSection: 'Knowledge checked in review', domainSection: 'Areas I\u2019m exploring',
      emptyCourses: 'Start with a course that interests you.', emptySkills: 'Every practice session is a step forward.',
      footer: 'Turn your materials into courses. Make progress visible.', scan: 'Scan to start learning',
      imageError: 'The card images could not load. Please retry.', canvasError: 'The learning card could not be created. Please retry.',
    },
  };
  const assets = new Map();
  function imageAsset(path, message) {
    if (!assets.has(path)) assets.set(path, new Promise((resolve, reject) => {
      const image = new Image();
      let settled = false;
      const failed = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); assets.delete(path); reject(new Error(message));
      };
      const timer = setTimeout(failed, 8000);
      image.onload = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(image); };
      image.onerror = failed;
      image.src = new URL(path, location.origin).href;
    }));
    return assets.get(path);
  }
  const fontFamily = '"Inter", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  const segments = value => typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment) : [...value];
  function font(context, size, weight = 400) { context.font = `${weight} ${size}px ${fontFamily}`; }
  function fit(context, value, width) {
    if (context.measureText(value).width <= width) return value;
    const parts = segments(value);
    while (parts.length && context.measureText(parts.join('') + '\u2026').width > width) parts.pop();
    return parts.join('') + '\u2026';
  }
  function wrap(context, value, width, limit = 2) {
    const characters = segments(value), lines = [];
    let line = '';
    while (characters.length) {
      const next = characters.shift();
      if (line && context.measureText(line + next).width > width) {
        if (lines.length === limit - 1) { lines.push(fit(context, line + next + characters.join(''), width)); return lines; }
        const breakAt = line.lastIndexOf(' ');
        if (breakAt > line.length / 3) {
          lines.push(line.slice(0, breakAt).trimEnd());
          line = line.slice(breakAt + 1) + next;
        } else { lines.push(line.trimEnd()); line = next.trimStart(); }
      } else line += next;
    }
    if (line || !lines.length) lines.push(line.trimEnd());
    return lines;
  }
  function rounded(context, x, y, width, height, radius, fill, stroke) {
    context.beginPath();
    context.moveTo(x + radius, y); context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius); context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height); context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius); context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y); context.closePath();
    if (fill) { context.fillStyle = fill; context.fill(); }
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = 1; context.stroke(); }
  }

  async function render(snapshot) {
    const text = words[snapshot.lang === 'en' ? 'en' : 'zh'];
    await document.fonts?.ready;
    const [logo, qr] = await Promise.all([
      imageAsset('/logo-mark.png', text.imageError), imageAsset('/project-qr.svg', text.imageError),
    ]);
    const canvas = document.createElement('canvas'); canvas.width = 1080;
    let ctx = canvas.getContext('2d'); if (!ctx) throw new Error(text.canvasError);
    const pad = 68, width = 944, courses = snapshot.courses.slice(0,4), skills = snapshot.skills.slice(0,8), domains = snapshot.domains.slice(0,6);
    const courseTop = 545, cardH = 106, gap = 13;
    const courseEnd = courseTop + 48 + Math.max(1,courses.length)*(cardH+gap)-gap;
    const skillTop = courseEnd+30, skillRows = Math.max(1,Math.ceil(skills.length/3));
    const domainTop = skillTop+50+skillRows*48+20, domainRows = Math.max(1,Math.ceil(domains.length/3));
    const contentEnd = domainTop + (domains.length?44+domainRows*48:0) + 112;
    canvas.height = Math.max(1200,contentEnd+205);
    ctx=canvas.getContext('2d'); ctx.textBaseline='top';
    const c={ink:'#1d3427',green:'#315f40',mid:'#638967',muted:'#718075',pale:'#edf3ea',line:'#e0e8dd',white:'#fff'};
    const bg=ctx.createLinearGradient(0,0,canvas.width,canvas.height); bg.addColorStop(0,'#fbfcfa');bg.addColorStop(1,'#eef3eb');
    ctx.fillStyle=bg;ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#eaf1e7';ctx.beginPath();ctx.arc(1000,150,175,0,Math.PI*2);ctx.fill();
    ctx.drawImage(logo,pad,48,46,46);font(ctx,29,650);ctx.fillStyle=c.ink;ctx.fillText('EduPilot',pad+60,57);
    const date=new Date(snapshot.generatedAt);font(ctx,17);ctx.fillStyle=c.muted;ctx.textAlign='right';
    ctx.fillText(Number.isFinite(date.getTime())?date.toLocaleDateString(snapshot.lang==='en'?'en-US':'zh-CN',{year:'numeric',month:'short',day:'numeric'}):'',canvas.width-pad,67);ctx.textAlign='left';
    ctx.fillStyle=c.line;ctx.fillRect(pad,120,width,1);
    font(ctx,15,650);ctx.fillStyle=c.mid;ctx.fillText(text.eyebrow.toUpperCase(),pad,151);
    font(ctx,55,700);ctx.fillStyle=c.ink;
    const title=wrap(ctx,snapshot.nickname?text.named(snapshot.nickname):text.title,width*.82,2);
    title.forEach((line,i)=>ctx.fillText(line,pad,184+i*64));
    font(ctx,24);ctx.fillStyle=c.muted;
    wrap(ctx,text.subtitle,width*.82,2).forEach((line,i)=>ctx.fillText(line,pad,184+title.length*64+12+i*34));
    rounded(ctx,pad,184+title.length*64+86,62,5,3,c.mid);

    const statsY=345,statW=(width-28)/3;
    [[snapshot.summary.courses,text.courses],[snapshot.summary.studiedTopics,text.studied],[snapshot.summary.masteredTopics,text.mastered]].forEach(([value,label],i)=>{
      const x=pad+i*(statW+14);rounded(ctx,x,statsY,statW,140,17,c.white,c.line);
      font(ctx,40,700);ctx.fillStyle=c.ink;ctx.fillText(String(value),x+20,statsY+28);
      font(ctx,16,500);ctx.fillStyle=c.muted;ctx.fillText(fit(ctx,label,statW-40),x+20,statsY+91);
      rounded(ctx,x+20,statsY+122,38,4,2,i===2?c.mid:'#dce8d8');
    });

    font(ctx,27,650);ctx.fillStyle=c.ink;ctx.fillText(text.courseSection,pad,courseTop);
    if(!courses.length){rounded(ctx,pad,courseTop+48,width,cardH,15,c.white,c.line);font(ctx,18);ctx.fillStyle=c.muted;ctx.fillText(text.emptyCourses,pad+22,courseTop+87);}
    courses.forEach((course,i)=>{
      const y=courseTop+48+i*(cardH+gap);rounded(ctx,pad,y,width,cardH,15,c.white,c.line);
      rounded(ctx,pad,y,6,cardH,3,i===0?c.green:c.mid);
      rounded(ctx,pad+22,y+21,42,42,12,c.pale);
      font(ctx,15,700);ctx.fillStyle=c.green;ctx.textAlign='center';ctx.fillText(String(i+1).padStart(2,'0'),pad+43,y+34);ctx.textAlign='left';
      font(ctx,22,650);ctx.fillStyle=c.ink;ctx.fillText(fit(ctx,course.title,width-280),pad+82,y+17);
      font(ctx,15);ctx.fillStyle=c.muted;
      const meta=snapshot.lang==='en'?course.studiedTopics+'/'+course.totalTopics+' concepts explored · '+course.masteredTopics+' review-passed':'已学 '+course.studiedTopics+' / '+course.totalTopics+' 个知识点 · 复习通过 '+course.masteredTopics;
      ctx.fillText(fit(ctx,meta,width-300),pad+82,y+51);
      const percent=Number.isFinite(course.studiedPercent)?course.studiedPercent:course.progressPercent;
      ctx.textAlign='right';font(ctx,22,700);ctx.fillStyle=c.green;ctx.fillText(percent+'%',canvas.width-pad-22,y+26);ctx.textAlign='left';
      rounded(ctx,pad+82,y+82,width-142,6,3,'#edf1eb');
      if(percent>0)rounded(ctx,pad+82,y+82,(width-142)*percent/100,6,3,c.mid);
    });

    function chips(items,y,title,variant){
      if(!items.length)return y;
      font(ctx,23,650);ctx.fillStyle=c.ink;ctx.fillText(title,pad,y);
      let x=pad,row=y+40;
      for(const item of items){
        font(ctx,16,550);const label=fit(ctx,item.title,245),w=Math.max(118,ctx.measureText(label).width+42);
        if(x+w>pad+width){x=pad;row+=48;}
        rounded(ctx,x,row,w,38,19,variant?c.pale:'#f5f7f3',variant?null:c.line);
        ctx.fillStyle=variant?c.green:c.muted;ctx.beginPath();ctx.arc(x+16,row+19,4,0,Math.PI*2);ctx.fill();
        font(ctx,16,550);ctx.fillText(label,x+28,row+10);x+=w+10;
      }
      return row+48;
    }
    let y=courseEnd+30;
    y=chips(skills,y,text.skillSection,true);
    if(!skills.length){font(ctx,16);ctx.fillStyle=c.muted;ctx.fillText(text.emptySkills,pad,y+4);y+=32;}
    y=chips(domains,y+14,text.domainSection,false);
    const quoteY=y+24;rounded(ctx,pad,quoteY,width,82,16,'#eaf1e7');
    font(ctx,22,550);ctx.fillStyle=c.ink;ctx.textAlign='center';
    ctx.fillText(snapshot.lang==='en'?'Every practice session is a step forward.':'每一次练习，都是下一步的起点。',canvas.width/2,quoteY+28);ctx.textAlign='left';

    const footerY=canvas.height-205;ctx.fillStyle='#e8efe5';ctx.fillRect(0,footerY,canvas.width,205);
    ctx.fillStyle=c.line;ctx.fillRect(pad,footerY+1,width,1);
    font(ctx,25,700);ctx.fillStyle=c.ink;ctx.fillText('EduPilot',pad,footerY+27);
    font(ctx,16);ctx.fillStyle=c.muted;wrap(ctx,text.footer,width-225,2).forEach((line,i)=>ctx.fillText(line,pad,footerY+65+i*24));
    font(ctx,15,550);ctx.fillStyle=c.green;ctx.fillText(fit(ctx,projectUrl,width-225),pad,footerY+126);
    rounded(ctx,canvas.width-pad-140,footerY+20,116,116,13,c.white,c.line);ctx.drawImage(qr,canvas.width-pad-134,footerY+26,104,104);
    font(ctx,13);ctx.fillStyle=c.muted;ctx.textAlign='center';ctx.fillText(text.scan,canvas.width-pad-82,footerY+145);ctx.textAlign='left';
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error(text.canvasError)),'image/png'));
    const day=Number.isFinite(date.getTime())?date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'):'progress';
    return {canvas,blob,filename:'EduPilot-learning-'+day+'.png'};
  }
  window.EduHomeShare = { projectUrl, buildSnapshot, render };
})();
