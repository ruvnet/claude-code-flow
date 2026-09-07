"""Owned cached-image fixture only; never builds/pulls/uses a shared store."""
import argparse, json, os, pathlib, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--worktree',required=True);p.add_argument('--state',required=True);a=p.parse_args()
w=pathlib.Path(a.worktree).resolve();s=pathlib.Path(a.state).resolve();s.mkdir(parents=True,exist_ok=False)
c=s/'config';c.mkdir(mode=0o700);control=s/'control';control.mkdir(mode=0o700)
image='sha256:16b333510bdc6dd068879fb0dcada89528a7030e4af4a66816b6359042dcee7d'
command=['docker','run','--rm','--pull=never','--network=none','--read-only','--name','codex-private-host-native-i100','--user',f'{os.getuid()}:{os.getgid()}','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit','128','--memory','2g','--cpus','2','--tmpfs','/data:rw,nosuid,nodev,size=256m,mode=1777','--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--workdir','/data','--env','PRIVATE_HOST_DISPOSABLE=1','--mount',f'type=bind,src={c},dst=/private-config,readonly','--mount',f'type=bind,src={control},dst=/control','--mount',f'type=bind,src={w}/v3/@claude-flow/cli/dist/src,dst=/app/node_modules/@claude-flow/cli/dist/src,readonly','--mount',f'type=bind,src={w}/v3/@claude-flow/cli/__tests__/fixtures,dst=/fixtures,readonly','--entrypoint','node',image,'/fixtures/private-whatsapp-host-native.mjs']
(s/'command.json').write_text(json.dumps(command));log=(s/'native.log').open('w');proc=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
def wait(name):
 end=time.monotonic()+45
 while not (control/name).exists():
  if proc.poll() is not None: raise RuntimeError(f'fixture exited {proc.returncode}; see native.log')
  if time.monotonic()>end: raise RuntimeError('fixture handshake timed out')
  time.sleep(.02)
def replace(value):
 tmp=c/'next';tmp.write_text(json.dumps(value,separators=(',',':')));tmp.chmod(0o600);os.replace(tmp,c/'current.json')
try:
 wait('initial.json');config=json.loads((control/'initial.json').read_text());replace(config);(control/'ready').touch()
 wait('rotate');replace(dict(config,revision='rotated'));(control/'rotated').touch();code=proc.wait(timeout=30)
 if code:raise RuntimeError(f'fixture exited {code}')
finally:
 if proc.poll() is None:subprocess.run(['docker','stop','--time','1','codex-private-host-native-i100'],capture_output=True);proc.wait(timeout=15)
 log.close()
