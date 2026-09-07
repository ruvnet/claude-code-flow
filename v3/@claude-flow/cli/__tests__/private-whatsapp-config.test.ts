import {expect,it} from 'vitest';
import {assertReadOnlyConfigDirectory} from '../src/mcp-tools/private-whatsapp-config.js';
const good='10 1 8:1 / / rw,relatime - ext4 /dev/root rw\n11 10 8:1 /config /private-config ro,relatime - ext4 /dev/root rw\n';
it('accepts only an exact read-only directory mount',()=>{expect(()=>assertReadOnlyConfigDirectory(good,'/private-config')).not.toThrow();});
for(const value of [
 good.replace('/private-config ro','/private-config rw'),good.replace('/private-config ro','/private-config/config.json ro'),
 good.replace('/private-config ro','/private-config/../private-config ro'),good.replace('/private-config ro','/private-config\\057hidden ro'),
 good+'12 10 8:1 /x /private-config/config.json ro - ext4 /dev/root rw\n',
 good+'12 10 8:1 /config /private-config ro - ext4 /dev/root rw\n',
 good.replace('11 10','10 10'),good.replace('ro,relatime','ro,rw'),good.replace(' - ext4',' malformed - ext4'),good+'\n',good.slice(0,-1)
])it('rejects malformed/ambiguous/nested-file/escaped mount evidence',()=>{expect(()=>assertReadOnlyConfigDirectory(value,'/private-config')).toThrow('configuration_unavailable');});
it('decodes documented kernel space escape exactly without prefix confusion',()=>{const s=good.replace('/private-config ro','/private\\040config ro');expect(()=>assertReadOnlyConfigDirectory(s,'/private config')).not.toThrow();expect(()=>assertReadOnlyConfigDirectory(s,'/private')).toThrow();});
