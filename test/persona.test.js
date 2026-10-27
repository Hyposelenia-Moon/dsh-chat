import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../model/db.js';
import {PersonaCards, syncPersonaCards} from '../lib/persona.js';

const owner = {chatId:'private:10001', senderId:'10001', role:'master'};
const groupOwner = {chatId:'group:123', senderId:'10001', role:'master'};
const member = {chatId:'group:123', senderId:'55', role:'member'};
const code = expected => error => error.code === expected;

function setup(t) { const db = new Store(); t.after(() => db.close()); return {db, cards:new PersonaCards({db})}; }

test('persona cards: owner-only create, rename, delete with unique names', t => {
  const {cards} = setup(t);
  assert.throws(() => cards.create({name:'A', prompt:'你是 A'}, member), code('FORBIDDEN'));
  const a = cards.create({name:'A', prompt:'你是 A'}, owner);
  assert.equal(a.id, 1);
  assert.equal(cards.list(owner).length, 1);
  assert.throws(() => cards.create({name:'A', prompt:'重复'}, owner), code('INVALID_ARGUMENT'));
  cards.update({id:a.id, name:'B', prompt:'你是 B'}, owner);
  assert.equal(cards.get({id:a.id}, owner).name, 'B');
  cards.remove({id:a.id}, owner);
  assert.equal(cards.list(owner).length, 0);
  assert.throws(() => cards.get({id:a.id}, owner), code('NOT_FOUND'));
});

test('persona binding is per chat, disabled or deleted cards stop applying', t => {
  const {cards} = setup(t);
  const a = cards.create({name:'A', prompt:'你是 A'}, owner);
  const b = cards.create({name:'B', prompt:'你是 B'}, owner);
  cards.bind({id:a.id}, groupOwner);
  assert.equal(cards.current('group:123').id, a.id);
  assert.equal(cards.current('private:10001'), null);
  cards.bind({id:b.id}, groupOwner);
  assert.equal(cards.current('group:123').id, b.id);
  cards.update({id:b.id, enabled:false}, owner);
  assert.equal(cards.current('group:123'), null);
  assert.throws(() => cards.bind({id:b.id}, groupOwner), code('INVALID_STATE'));
  cards.update({id:b.id, enabled:true}, owner);
  cards.bind({id:b.id}, groupOwner);
  cards.remove({id:b.id}, owner);
  assert.equal(cards.current('group:123'), null);
  assert.equal(cards.unbind({}, groupOwner).cleared, false);
});

test('guoba bulk JSON syncs cards by name and deletes the ones left out', t => {
  const {db, cards} = setup(t);
  const a = cards.create({name:'A', prompt:'你是 A'}, owner);
  cards.bind({id:a.id}, groupOwner);
  assert.equal(syncPersonaCards(JSON.stringify([{name:'A', prompt:'你是 A2'}, {name:'B', prompt:'你是 B'}]), db).synced, 2);
  assert.equal(cards.get({id:a.id}, owner).prompt, '你是 A2');
  assert.equal(cards.list(owner).length, 2);
  assert.equal(syncPersonaCards(JSON.stringify([{name:'B', prompt:'你是 B'}]), db).synced, 1);
  assert.equal(cards.list(owner).length, 1);
  assert.equal(cards.current('group:123'), null);
  assert.deepEqual(syncPersonaCards('', db), {skipped:true});
  assert.equal(syncPersonaCards('not json', db).error, 'not json');
  assert.equal(syncPersonaCards('[{"name":""}]', db).error, 'no valid card');
});

test('persona cards reject empty prompts and overlong names', t => {
  const {cards} = setup(t);
  assert.throws(() => cards.create({name:'', prompt:'x'}, owner), code('INVALID_ARGUMENT'));
  assert.throws(() => cards.create({name:'x'.repeat(41), prompt:'x'}, owner), code('INVALID_ARGUMENT'));
  assert.throws(() => cards.create({name:'A', prompt:'   '}, owner), code('INVALID_ARGUMENT'));
  assert.throws(() => cards.create({name:'A', prompt:'x'.repeat(16001)}, owner), code('INVALID_ARGUMENT'));
});

