// A duplicate is successful only if the same student's exact seller row exists.
// The second read covers concurrent inserts; unrelated conflicts stay errors.
export async function addStorefrontOnce({ find, insert }) {
  const existing = await find();
  if (existing) return { added: false, storefront: existing };
  try {
    return { added: true, storefront: await insert() };
  } catch (error) {
    if (error.response?.data?.code !== '23505') throw error;
    const winner = await find();
    if (!winner) throw error;
    return { added: false, storefront: winner };
  }
}

export function commandErrorMessage(error) {
  // Only local input/authorization errors are safe to show verbatim. Never
  // expose database details, request URLs, tokens, or provider response bodies.
  const text = String(error.message || '');
  if (!error.response && error.code === 'STOREFRONT_BLOCKED') return 'This storefront is protected and cannot be tracked in Buy Box Bandit.';
  if (!error.response && /^(Run `\/setup`|Use this command inside|Enter a valid Amazon seller ID|Enter your full name\.|Enter a valid email address\.|You need the Buy Box Bandit Student role)/.test(text)) return text;
  return 'The service could not finish this command. Please try again shortly. Your saved storefronts have not been cleared.';
}

export async function deferredCommand({ acknowledge, work, edit, log = () => {} }) {
  // Do not run mutations unless Discord successfully acknowledged the command.
  await acknowledge();
  let data;
  try { data = (await work()).data; }
  catch (error) {
    log('discord_command_failed', error);
    data = { content: commandErrorMessage(error) };
  }
  const payload = { ...data, allowed_mentions: { parse: [] } };
  delete payload.flags; // Ephemeral visibility is set by the initial response.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await edit(payload); return; }
    catch (error) {
      if (attempt === 1 || [401, 403, 404].includes(error.response?.status)) {
        log('discord_reply_failed', error);
        return;
      }
    }
  }
}

export function storefrontListMessage(stores) {
  if (!stores.length) return 'You are not tracking any storefronts yet. Use `/add`.';
  let text = `**Your tracked storefronts (${stores.length})**\n\n`;
  let shown = 0;
  for (const store of stores) {
    const row = `${shown + 1}. **${store.label || store.seller_id}**\n   ${store.seller_id}${store.blocked ? ' — Protected; tracking disabled' : ''}\n`;
    if (text.length + row.length > 1800) break;
    text += row;
    shown += 1;
  }
  if (shown < stores.length) text += `\nShowing ${shown} of ${stores.length}. View the full list at https://app.sellersyndicate.org.`;
  return text;
}
