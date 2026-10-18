// Immutable encrypted captain links. The private key stays in the URL fragment.
export const SHORT_LINK_MAX_BYTES = 4096;
export const shortIdValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const shortTokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(value);
export const shortSlugValid = value => typeof value === 'string' && value.length <= 97 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*_[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
export const shortPathValid = path => typeof path === 'string' && path.startsWith('/') && shortSlugValid(path.slice(1));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function shortRecordValid(row) {
  return exact(row, ['v', 'id', 'slug', 'box']) && row.v === 1 && shortIdValid(row.id) && shortSlugValid(row.slug) &&
    exact(row.box, ['iv', 'data']) && typeof row.box.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(row.box.iv) &&
    typeof row.box.data === 'string' && row.box.data.length >= 24 && row.box.data.length <= 3000 &&
    /^[A-Za-z0-9_-]+$/.test(row.box.data);
}
