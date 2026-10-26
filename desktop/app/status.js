function update(state) {
  const failed = state.phase === 'failed';
  document.getElementById('title').textContent = failed ? '工作台暂时无法连接。' : state.phase === 'recovering' ? '正在恢复你的工作台。' : '准备好，继续学习。';
  document.getElementById('message').textContent = failed ? '请重新连接。若仍无法打开，可以查看日志。' : state.phase === 'recovering' ? '连接意外中断，正在自动恢复。未完成的操作请在恢复后检查。' : '正在打开你的学习工作台。';
  document.getElementById('actions').hidden = !failed;
  document.getElementById('progress').hidden = failed;
}
window.edupilotDesktop.onState(update);
window.edupilotDesktop.state().then(update);
document.getElementById('retry').onclick = () => window.edupilotDesktop.retry();
document.getElementById('logs').onclick = () => window.edupilotDesktop.logs();
