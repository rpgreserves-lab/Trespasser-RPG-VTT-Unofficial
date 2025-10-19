
class TrespasserActor extends Actor {
  prepareDerivedData() {
    super.prepareDerivedData();
    const s = this.system;
    if (s.resources) {
      // Ensure resource branches exist
      s.resources.stamina = s.resources.stamina || { value: 1, max: 1 };
      s.resources.wounds  = s.resources.wounds  || { value: 0, max: 1 };
      s.resources.fate    = s.resources.fate    || { value: 0, max: 0 };

      // Compute separate baseMax values from stats (do NOT overwrite user-editable max)
      s.resources.stamina.baseMax = Number(s.stats?.stamina ?? 1);
      s.resources.wounds.baseMax  = Number(s.stats?.wounds  ?? 2);

      // Backfill editable max only if missing
      if (s.resources.stamina.max == null) s.resources.stamina.max = s.resources.stamina.baseMax;
      if (s.resources.wounds.max  == null) s.resources.wounds.max  = s.resources.wounds.baseMax;

      // Clamp current values to their max
      if (s.resources.stamina.value > s.resources.stamina.max) s.resources.stamina.value = s.resources.stamina.max;
      if (s.resources.wounds.value  > s.resources.wounds.max ) s.resources.wounds.value  = s.resources.wounds.max;
    }

    // Convert minor wounds → wounds (3 minors = 1 wound)
    if (s?.derived?.minorWounds >= 3) {
      const add = Math.floor(s.derived.minorWounds / 3);
      s.derived.minorWounds = s.derived.minorWounds % 3;
      s.resources.wounds.value = (s.resources.wounds.value ?? 0) + add;
    }
  }
}

class TrespasserItem extends Item {}

class TrespasserActorSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["trespasser", "sheet", "actor"],
      template: "systems/trespasser-rpg/templates/actor-sheet.hbs",
      width: 760,
      height: 640,
      submitOnChange: true,
      tabs: [{ navSelector: ".sheet-tabs", contentSelector: ".sheet-body", initial: "stats" }]
    });
  }

  async getData(options) {
    const ctx = await super.getData(options);
    ctx.system   = this.actor.system;
    ctx.editable = this.isEditable;
    return ctx;
  }

  activateListeners(html) {
    super.activateListeners(html);
    // Inventory controls
    html.find('[data-action="create-item"]').on('click', this._onCreateItem.bind(this));
    html.find('[data-action="edit-item"]').on('click', this._onEditItem.bind(this));
    html.find('[data-action="delete-item"]').on('click', this._onDeleteItem.bind(this));
    html.find('[data-item-edit]').on('change', this._onInlineItemEdit.bind(this));
    // Rolls
    html.find('[data-action="challenge"]').on('click', this._onChallenge.bind(this));
    html.find('[data-action="attack"]').on('click', this._onAttack.bind(this));
  }

  async _onCreateItem(event) {
    event.preventDefault();
    const select = this.element.find('select[name="newItemType"]');
    const type = select.val() || 'gear';
    const itemData = { name: `New ${type}`, type, system: {} };
    await this.actor.createEmbeddedDocuments('Item', [itemData]);
  }

  async _onEditItem(event) {
    event.preventDefault();
    const id = event.currentTarget.closest('[data-item-id]')?.dataset.itemId;
    const item = this.actor.items.get(id);
    if (item) item.sheet.render(true);
  }

  async _onDeleteItem(event) {
    event.preventDefault();
    const id = event.currentTarget.closest('[data-item-id]')?.dataset.itemId;
    if (!id) return;
    await this.actor.deleteEmbeddedDocuments('Item', [id]);
  }

  async _onInlineItemEdit(event) {
    const input = event.currentTarget;
    const row = input.closest('[data-item-id]');
    const id = row?.dataset.itemId;
    const path = input.dataset.itemEdit;
    if (!id || !path) return;
    let value = input.type === 'checkbox' ? input.checked : input.value;
    if (input.dataset.dtype === 'Number') value = Number(value) || 0;
    const item = this.actor.items.get(id);
    if (item) await item.update({ [path]: value });
  }

  async _onChallenge(event){
    event.preventDefault();
    const stat = event.currentTarget.dataset.stat || 'knowledge';
    await trespasserRolls.challenge(this.actor, stat);
  }

  async _onAttack(event){
    event.preventDefault();
    const id = event.currentTarget.dataset.itemId;
    const weapon = this.actor.items.get(id);
    if (!weapon) return ui.notifications.warn("Select a weapon to attack with.");
    const target = game.user?.targets?.first();
    await trespasserRolls.attack(this.actor, weapon, target?.actor ?? null);
  }
}

class TrespasserItemSheet extends ItemSheet {
  static get defaultOptions(){
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["trespasser","sheet","item"],
      template: "systems/trespasser-rpg/templates/item-sheet.hbs",
      width: 560,
      height: 520,
      submitOnChange: true
    });
  }
}

export const trespasserRolls = {
  async _promptBoonsBanes(){
    return await new Promise((resolve)=>{
      const content = `
        <form>
          <div class="form-group"><label>Number of Boons:</label>
            <input type="number" name="boons" value="0" min="0" max="3"/>
          </div>
          <div class="form-group"><label>Number of Banes:</label>
            <input type="number" name="banes" value="0" min="0" max="3"/>
          </div>
          <div class="form-group"><label>Flat Modifier:</label>
            <input type="text" name="modifier" value="+0"/>
          </div>
        </form>`;
      new Dialog({
        title: 'Preparing a dice roll', content,
        buttons: {
          roll: { label: 'Roll!', callback: html => {
            let boons = parseInt(html.find('[name="boons"]').val()) || 0;
            let banes = parseInt(html.find('[name="banes"]').val()) || 0;
            const modifierText = (html.find('[name="modifier"]').val() || '+0').toString().trim();
            const modifier = parseInt(modifierText) || 0;
            resolve({boons, banes, modifier, modifierText});
          }},
          cancel: { label: 'Cancel', callback: () => resolve(null) }
        }, default: 'roll'
      }).render(true);
    });
  },

  async challenge(actor, statKey){
    const stat = getProperty(actor.system, `stats.${statKey}`) ?? 0;
    const input = await this._promptBoonsBanes();
    if (!input) return;
    let {boons, banes, modifier, modifierText} = input;
    let netDice = Math.max(-3, Math.min(3, boons - banes));
    let formula = '1d20';
    if (netDice > 0) formula += ` + ${netDice}d6`;
    else if (netDice < 0) formula += ` - ${Math.abs(netDice)}d6`;
    if (modifier !== 0) formula += (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`);
    if (stat !== 0) formula += (stat > 0 ? ` + ${stat}` : ` - ${Math.abs(stat)}`);

    const roll = await (new Roll(formula)).evaluate({async:true});
    const flavor = `<b>${actor.name}</b> — <i>${statKey.toUpperCase()} Challenge</i><br>
      <b>Boons:</b> ${boons} &nbsp; <b>Banes:</b> ${banes} &nbsp; <b>Modifier:</b> ${modifierText}<br>
      <b>Net dice:</b> ${netDice} &nbsp; <b>Formula:</b> ${formula}`;
    roll.toMessage({speaker: ChatMessage.getSpeaker({actor}), flavor});
    return roll.total;
  },

  async attack(attacker, weapon, defender=null){
    const statKey = weapon.system.stat || 'dexterity';
    const stat = getProperty(attacker.system, `stats.${statKey}`) ?? 0;
    const targetEvade = defender ? (defender.system?.stats?.evade ?? 10) : 10;

    const r = await (new Roll(`1d20 + @stat`, {stat})).evaluate({async:true});
    const hit = r.total >= targetEvade;
    let dmgLine = "";
    if (hit && weapon.system?.damage){
      const dmg = await (new Roll(weapon.system.damage, attacker.getRollData())).evaluate({async:true});
      const armor = defender ? (defender.system?.stats?.armor ?? 0) : 0;
      let woundText = "Minor wound";
      if (defender){
        let updates = {};
        if (dmg.total < armor){
          const minors = Number(defender.system?.derived?.minorWounds ?? 0) + 1;
          updates['system.derived.minorWounds'] = minors;
          if (minors >= 3){
            updates['system.derived.minorWounds'] = minors % 3;
            const currentW = Number(defender.system?.resources?.wounds?.value ?? 0) + Math.floor(minors/3);
            updates['system.resources.wounds.value'] = currentW;
            woundText = `${Math.floor(minors/3)} Wound(s)`;
          }
        } else if (dmg.total >= 2*armor){
          const currentW = Number(defender.system?.resources?.wounds?.value ?? 0) + 2;
          updates['system.resources.wounds.value'] = currentW;
          woundText = "2 Wounds";
        } else {
          const currentW = Number(defender.system?.resources?.wounds?.value ?? 0) + 1;
          updates['system.resources.wounds.value'] = currentW;
          woundText = "1 Wound";
        }
        if (Object.keys(updates).length) await defender.update(updates);
      }
      if (weapon.system?.uses?.value > 0){
        await weapon.update({'system.uses.value': Math.max(0, weapon.system.uses.value - 1)});
      } else if (Number.isFinite(weapon.system?.mag) && weapon.system.mag > 0){
        await weapon.update({'system.mag': Math.max(0, weapon.system.mag - 1)});
      }
      dmgLine = `<p>Damage: ${weapon.system.damage} = <b>${dmg.total}</b> vs Armor ${armor} → ${woundText}</p>`;
    }

    const content = `<div class="tres-card"><h3>Attack: ${weapon.name}</h3>
      <p>Attack: ${r.formula} = <b>${r.total}</b> vs Evade ${targetEvade} → ${hit?"HIT":"MISS"}</p>
      ${dmgLine}</div>`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: attacker}), content});
  }
}

Hooks.once('init', function(){
  CONFIG.Actor.documentClass = TrespasserActor;
  CONFIG.Item.documentClass = TrespasserItem;
  Actors.unregisterSheet('core', ActorSheet);
  Actors.registerSheet('trespasser-rpg', TrespasserActorSheet, {types:['trespasser','npc','vehicle'], makeDefault:true});
  Items.unregisterSheet('core', ItemSheet);
  Items.registerSheet('trespasser-rpg', TrespasserItemSheet, {makeDefault:true});
});
