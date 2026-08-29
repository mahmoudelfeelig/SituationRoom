import {
  DENSITIES,
  entityRefKey,
  getDomainKind,
  isEntityRef,
  isPlainRecord,
  LENSES,
  PRESENTATION_SCHEMA_VERSION,
  REGIONS,
  SNAPSHOT_ROOT_KEYS,
} from "./contracts.js";
import { getInstrumentDefinition, validateInstrumentPlacement } from "./instrumentRegistry.js";
import { validateLayout } from "./layoutRegistry.js";
import { createPresentationIndex, resolveEntityRef } from "./presentationSelectors.js";

const RECIPE_KEYS = new Set([
  "schemaVersion",
  "recipeId",
  "intent",
  "lens",
  "question",
  "framing",
  "layout",
  "instruments",
  "focus",
  "expectedDecisionRevision",
  "expectedViewRevision",
]);
const INSTRUMENT_KEYS = new Set([
  "id",
  "type",
  "region",
  "priority",
  "entityRefs",
  "pathId",
  "variant",
  "options",
]);
const FOCUS_KEYS = new Set(["entityRef", "pathId"]);
const SAFE_INTENTS = new Set(["explain", "compare", "simulate", "brief", "challenge", "audit"]);

function hasOnlyKeys(value, allowedKeys, label, errors) {
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length) errors.push(`${label} contains unknown fields: ${unknown.join(", ")}.`);
}

function validateBoundedString(value, label, errors, { minimum = 1, maximum = 5000 } = {}) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string.`);
    return;
  }
  if (value.length < minimum || value.length > maximum) {
    errors.push(`${label} must contain between ${minimum} and ${maximum} characters.`);
  }
  if (value.includes("\u0000")) errors.push(`${label} contains a prohibited null character.`);
}

function validateJsonValue(value, label, errors, depth = 0) {
  if (depth > 5) {
    errors.push(`${label} exceeds the maximum nesting depth.`);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${label} must contain finite numbers.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 10000) errors.push(`${label} contains a string longer than 10,000 characters.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) errors.push(`${label} contains more than 500 items.`);
    value.slice(0, 501).forEach((entry, index) =>
      validateJsonValue(entry, `${label}[${index}]`, errors, depth + 1),
    );
    return;
  }
  if (!isPlainRecord(value)) {
    errors.push(`${label} must contain JSON-compatible values only.`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > 200) errors.push(`${label} contains more than 200 fields.`);
  for (const key of keys.slice(0, 201)) {
    validateJsonValue(value[key], `${label}.${key}`, errors, depth + 1);
  }
}

function validateEntityCollection(collection, label, fallbackKind, errors, keys) {
  if (!Array.isArray(collection)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (collection.length > 10000) errors.push(`${label} cannot contain more than 10,000 items.`);
  for (const [index, item] of collection.entries()) {
    if (!isPlainRecord(item)) {
      errors.push(`${label}[${index}] must be an object.`);
      continue;
    }
    validateBoundedString(item.id, `${label}[${index}].id`, errors, { maximum: 160 });
    const kind = item.kind || fallbackKind;
    validateBoundedString(kind, `${label}[${index}].kind`, errors, { maximum: 80 });
    const key = entityRefKey({ kind, id: item.id });
    if (keys.has(key)) errors.push(`Duplicate canonical reference: ${key}.`);
    keys.add(key);
    if (item.label !== undefined) {
      validateBoundedString(item.label, `${label}[${index}].label`, errors, { maximum: 500 });
    }
    if (item.summary !== undefined) {
      validateBoundedString(item.summary, `${label}[${index}].summary`, errors, {
        minimum: 0,
        maximum: 10000,
      });
    }
    if (item.attributes !== undefined) {
      validateJsonValue(item.attributes, `${label}[${index}].attributes`, errors);
    }
    validateJsonValue(item, `${label}[${index}]`, errors);
  }
}

export function validatePresentationSnapshot(snapshot) {
  const errors = [];
  if (!isPlainRecord(snapshot)) return { ok: false, errors: ["Presentation snapshot must be an object."] };

  const unknownRootKeys = Object.keys(snapshot).filter((key) => !SNAPSHOT_ROOT_KEYS.includes(key));
  if (unknownRootKeys.length) errors.push(`Snapshot contains unknown fields: ${unknownRootKeys.join(", ")}.`);
  if (snapshot.schemaVersion !== PRESENTATION_SCHEMA_VERSION) {
    errors.push(`Snapshot schemaVersion must be ${PRESENTATION_SCHEMA_VERSION}.`);
  }
  validateBoundedString(snapshot.caseId, "snapshot.caseId", errors, { maximum: 160 });
  validateBoundedString(snapshot.decisionHash, "snapshot.decisionHash", errors, { maximum: 200 });
  if (!Number.isInteger(snapshot.decisionRevision) || snapshot.decisionRevision < 1) {
    errors.push("snapshot.decisionRevision must be a positive integer.");
  }
  if (!Number.isInteger(snapshot.viewRevision) || snapshot.viewRevision < 1) {
    errors.push("snapshot.viewRevision must be a positive integer.");
  }
  if (typeof snapshot.frozen !== "boolean") errors.push("snapshot.frozen must be a boolean.");

  if (!isPlainRecord(snapshot.domain)) {
    errors.push("snapshot.domain must be an object.");
  } else {
    validateBoundedString(snapshot.domain.id, "snapshot.domain.id", errors, { maximum: 100 });
    validateBoundedString(snapshot.domain.kind, "snapshot.domain.kind", errors, { maximum: 80 });
    validateBoundedString(snapshot.domain.label, "snapshot.domain.label", errors, { maximum: 200 });
  }
  if (!isPlainRecord(snapshot.contract)) {
    errors.push("snapshot.contract must be an object.");
  } else {
    validateBoundedString(snapshot.contract.title, "snapshot.contract.title", errors, { maximum: 500 });
    validateBoundedString(snapshot.contract.question, "snapshot.contract.question", errors, { maximum: 2000 });
  }

  const canonicalKeys = new Set();
  validateEntityCollection(snapshot.entities, "snapshot.entities", "entity", errors, canonicalKeys);
  validateEntityCollection(snapshot.results, "snapshot.results", "result", errors, canonicalKeys);
  validateEntityCollection(snapshot.sources, "snapshot.sources", "source", errors, canonicalKeys);

  const entityIds = new Set((snapshot.entities ?? []).map((entity) => entity.id));
  const sourceIds = new Set((snapshot.sources ?? []).map((source) => source.id));
  for (const [index, result] of (snapshot.results ?? []).entries()) {
    if (result.subjectId !== undefined && !entityIds.has(result.subjectId)) {
      errors.push(`snapshot.results[${index}].subjectId must resolve to a canonical entity.`);
    }
    if (result.criterionId !== undefined && !entityIds.has(result.criterionId)) {
      errors.push(`snapshot.results[${index}].criterionId must resolve to a canonical entity.`);
    }
    if (result.evidenceIds !== undefined) {
      if (!Array.isArray(result.evidenceIds) || result.evidenceIds.some((id) => !entityIds.has(id) && !sourceIds.has(id))) {
        errors.push(`snapshot.results[${index}].evidenceIds must resolve to canonical evidence or sources.`);
      }
    }
  }
  for (const [index, source] of (snapshot.sources ?? []).entries()) {
    if (source.locations !== undefined) {
      if (!Array.isArray(source.locations)) {
        errors.push(`snapshot.sources[${index}].locations must be an array.`);
      } else {
        source.locations.forEach((location, locationIndex) => {
          if (!isPlainRecord(location)) {
            errors.push(`snapshot.sources[${index}].locations[${locationIndex}] must be an object.`);
            return;
          }
          validateBoundedString(location.label, `snapshot.sources[${index}].locations[${locationIndex}].label`, errors, { maximum: 500 });
          if (typeof location.locator === "string") {
            validateBoundedString(
              location.locator,
              `snapshot.sources[${index}].locations[${locationIndex}].locator`,
              errors,
              { maximum: 1000 },
            );
          } else {
            validateJsonValue(
              location.locator,
              `snapshot.sources[${index}].locations[${locationIndex}].locator`,
              errors,
            );
          }
        });
      }
    }
  }

  if (!Array.isArray(snapshot.relations)) errors.push("snapshot.relations must be an array.");
  if (!Array.isArray(snapshot.paths)) errors.push("snapshot.paths must be an array.");
  if (!Array.isArray(snapshot.pins)) errors.push("snapshot.pins must be an array.");
  if (!isPlainRecord(snapshot.protected)) errors.push("snapshot.protected must be an object.");
  if (!isPlainRecord(snapshot.policy)) errors.push("snapshot.policy must be an object.");
  if (!isPlainRecord(snapshot.permissions)) errors.push("snapshot.permissions must be an object.");

  if (Array.isArray(snapshot.relations)) {
    const relationIds = new Set();
    for (const [index, relation] of snapshot.relations.entries()) {
      if (!isPlainRecord(relation)) {
        errors.push(`snapshot.relations[${index}] must be an object.`);
        continue;
      }
      validateBoundedString(relation.id, `snapshot.relations[${index}].id`, errors, { maximum: 160 });
      if (relationIds.has(relation.id)) errors.push(`Duplicate relation ID: ${relation.id}.`);
      relationIds.add(relation.id);
      if (!isEntityRef(relation.from) || !canonicalKeys.has(entityRefKey(relation.from))) {
        errors.push(`snapshot.relations[${index}].from must resolve to a canonical item.`);
      }
      if (!isEntityRef(relation.to) || !canonicalKeys.has(entityRefKey(relation.to))) {
        errors.push(`snapshot.relations[${index}].to must resolve to a canonical item.`);
      }
    }
  }

  const resultIds = new Set((snapshot.results ?? []).map((result) => result.id));
  if (Array.isArray(snapshot.paths)) {
    const pathIds = new Set();
    for (const [index, path] of snapshot.paths.entries()) {
      if (!isPlainRecord(path)) {
        errors.push(`snapshot.paths[${index}] must be an object.`);
        continue;
      }
      validateBoundedString(path.id, `snapshot.paths[${index}].id`, errors, { maximum: 160 });
      if (pathIds.has(path.id)) errors.push(`Duplicate path ID: ${path.id}.`);
      pathIds.add(path.id);
      if (!Array.isArray(path.entityRefs)) {
        errors.push(`snapshot.paths[${index}].entityRefs must be an array.`);
      } else {
        path.entityRefs.forEach((reference, referenceIndex) => {
          if (!isEntityRef(reference) || !canonicalKeys.has(entityRefKey(reference))) {
            errors.push(
              `snapshot.paths[${index}].entityRefs[${referenceIndex}] must resolve to a canonical item.`,
            );
          }
        });
      }
      if (path.resultIds !== undefined) {
        if (!Array.isArray(path.resultIds) || path.resultIds.some((id) => !resultIds.has(id))) {
          errors.push(`snapshot.paths[${index}].resultIds must resolve to canonical results.`);
        }
      }
    }
  }

  if (Array.isArray(snapshot.pins)) {
    snapshot.pins.forEach((reference, index) => {
      if (!isEntityRef(reference)) errors.push(`snapshot.pins[${index}] must be an entity reference.`);
    });
  }
  if (isPlainRecord(snapshot.protected)) {
    if (!Array.isArray(snapshot.protected.entityRefs)) {
      errors.push("snapshot.protected.entityRefs must be an array.");
    } else {
      snapshot.protected.entityRefs.forEach((reference, index) => {
        if (!isEntityRef(reference)) {
          errors.push(`snapshot.protected.entityRefs[${index}] must be an entity reference.`);
        }
      });
    }
    if (!Array.isArray(snapshot.protected.blockerResultIds)) {
      errors.push("snapshot.protected.blockerResultIds must be an array.");
    } else if (snapshot.protected.blockerResultIds.some((id) => !resultIds.has(id))) {
      errors.push("snapshot.protected.blockerResultIds must resolve to canonical results.");
    }
    if (
      snapshot.protected.omittedEntityCount !== undefined &&
      (!Number.isInteger(snapshot.protected.omittedEntityCount) || snapshot.protected.omittedEntityCount < 0)
    ) {
      errors.push("snapshot.protected.omittedEntityCount must be a non-negative integer.");
    }
  }
  if (isPlainRecord(snapshot.policy)) {
    const { allowedInstrumentTypes, blockedInstrumentTypes, maxInstrumentCount } = snapshot.policy;
    if (allowedInstrumentTypes !== null && allowedInstrumentTypes !== undefined && !Array.isArray(allowedInstrumentTypes)) {
      errors.push("snapshot.policy.allowedInstrumentTypes must be null or an array.");
    }
    if (!Array.isArray(blockedInstrumentTypes ?? [])) {
      errors.push("snapshot.policy.blockedInstrumentTypes must be an array.");
    }
    for (const type of [...(allowedInstrumentTypes ?? []), ...(blockedInstrumentTypes ?? [])]) {
      if (typeof type !== "string" || !getInstrumentDefinition(type)) {
        errors.push(`snapshot.policy references an unknown instrument type: ${String(type)}.`);
      }
    }
    if (maxInstrumentCount !== undefined && (!Number.isInteger(maxInstrumentCount) || maxInstrumentCount < 2 || maxInstrumentCount > 24)) {
      errors.push("snapshot.policy.maxInstrumentCount must be an integer between 2 and 24.");
    }
  }

  if (isPlainRecord(snapshot.permissions)) {
    for (const key of ["canCompose", "canSimulate", "canApprove"]) {
      if (snapshot.permissions[key] !== undefined && typeof snapshot.permissions[key] !== "boolean") {
        errors.push(`snapshot.permissions.${key} must be a boolean.`);
      }
    }
  }

  if (snapshot.metadata !== undefined) validateJsonValue(snapshot.metadata, "snapshot.metadata", errors);
  if (snapshot.domainData !== undefined) validateJsonValue(snapshot.domainData, "snapshot.domainData", errors);

  return { ok: errors.length === 0, errors };
}

function validateFocus(snapshot, focus, errors) {
  if (focus === undefined) return;
  if (!isPlainRecord(focus)) {
    errors.push("recipe.focus must be an object.");
    return;
  }
  hasOnlyKeys(focus, FOCUS_KEYS, "recipe.focus", errors);
  const index = createPresentationIndex(snapshot);
  if (focus.entityRef !== undefined) {
    if (!isEntityRef(focus.entityRef) || !resolveEntityRef(index, focus.entityRef)) {
      errors.push("recipe.focus.entityRef must resolve to a canonical item.");
    }
  }
  if (focus.pathId !== undefined && !index.pathsById.has(focus.pathId)) {
    errors.push("recipe.focus.pathId must resolve to a canonical path.");
  }
}

export function validatePresentationRecipe(snapshot, recipe) {
  const errors = [];
  const snapshotValidation = validatePresentationSnapshot(snapshot);
  if (!snapshotValidation.ok) {
    return {
      ok: false,
      errors: snapshotValidation.errors.map((error) => `Invalid snapshot: ${error}`),
    };
  }
  if (!isPlainRecord(recipe)) return { ok: false, errors: ["Presentation recipe must be an object."] };

  hasOnlyKeys(recipe, RECIPE_KEYS, "Recipe", errors);
  if (recipe.schemaVersion !== PRESENTATION_SCHEMA_VERSION) {
    errors.push(`recipe.schemaVersion must be ${PRESENTATION_SCHEMA_VERSION}.`);
  }
  validateBoundedString(recipe.recipeId, "recipe.recipeId", errors, { maximum: 160 });
  if (!SAFE_INTENTS.has(recipe.intent)) errors.push(`Unsupported recipe intent: ${String(recipe.intent)}.`);
  if (!LENSES.includes(recipe.lens)) errors.push(`Unsupported recipe lens: ${String(recipe.lens)}.`);
  validateBoundedString(recipe.question, "recipe.question", errors, { minimum: 4, maximum: 240 });
  if (recipe.framing !== undefined) {
    validateBoundedString(recipe.framing, "recipe.framing", errors, { minimum: 0, maximum: 180 });
  }
  errors.push(...validateLayout(recipe.lens, recipe.layout));
  if (!Number.isInteger(recipe.expectedDecisionRevision) || recipe.expectedDecisionRevision < 1) {
    errors.push("recipe.expectedDecisionRevision must be a positive integer.");
  }
  if (!Number.isInteger(recipe.expectedViewRevision) || recipe.expectedViewRevision < 1) {
    errors.push("recipe.expectedViewRevision must be a positive integer.");
  }

  const domain = getDomainKind(snapshot);
  const index = createPresentationIndex(snapshot);
  const policy = snapshot.policy ?? {};
  const allowedTypes = Array.isArray(policy.allowedInstrumentTypes)
    ? new Set(policy.allowedInstrumentTypes)
    : null;
  const blockedTypes = new Set(policy.blockedInstrumentTypes ?? []);

  if (!Array.isArray(recipe.instruments)) {
    errors.push("recipe.instruments must be an array.");
  } else {
    if (recipe.instruments.length > 24) errors.push("A recipe may request at most 24 instruments.");
    const instrumentIds = new Set();
    recipe.instruments.forEach((instrument, instrumentIndex) => {
      const prefix = `recipe.instruments[${instrumentIndex}]`;
      if (!isPlainRecord(instrument)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      hasOnlyKeys(instrument, INSTRUMENT_KEYS, prefix, errors);
      validateBoundedString(instrument.id, `${prefix}.id`, errors, { maximum: 160 });
      if (typeof instrument.id === "string" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(instrument.id)) {
        errors.push(`${prefix}.id must be a stable identifier without spaces or markup.`);
      }
      if (typeof instrument.id === "string" && instrument.id.startsWith("system-")) {
        errors.push(`${prefix}.id uses the reserved system namespace.`);
      }
      if (instrumentIds.has(instrument.id)) errors.push(`Duplicate instrument ID: ${instrument.id}.`);
      instrumentIds.add(instrument.id);
      if (!Number.isInteger(instrument.priority) || instrument.priority < -100 || instrument.priority > 100) {
        errors.push(`${prefix}.priority must be an integer between -100 and 100.`);
      }
      if (!REGIONS.includes(instrument.region)) {
        errors.push(`${prefix}.region is unsupported.`);
      }
      const definition = getInstrumentDefinition(instrument.type);
      if (definition?.protectedType) {
        errors.push(`${instrument.type} is system-injected and cannot be requested by a recipe.`);
      }
      for (const placementError of validateInstrumentPlacement(instrument, {
        domain,
        lens: recipe.lens,
      })) {
        errors.push(`${prefix}: ${placementError}`);
      }
      if (allowedTypes && !allowedTypes.has(instrument.type)) {
        errors.push(`${instrument.type} is not allowed by the active case policy.`);
      }
      if (blockedTypes.has(instrument.type)) {
        errors.push(`${instrument.type} is blocked by the active case policy.`);
      }
      if (!Array.isArray(instrument.entityRefs)) {
        errors.push(`${prefix}.entityRefs must be an array.`);
      } else {
        instrument.entityRefs.forEach((reference, referenceIndex) => {
          if (!isEntityRef(reference) || !resolveEntityRef(index, reference)) {
            errors.push(`${prefix}.entityRefs[${referenceIndex}] must resolve to a canonical item.`);
          }
        });
      }
      if (instrument.pathId !== undefined && !index.pathsById.has(instrument.pathId)) {
        errors.push(`${prefix}.pathId must resolve to a canonical path.`);
      }
    });
  }

  validateFocus(snapshot, recipe.focus, errors);
  return { ok: errors.length === 0, errors };
}

export const PRESENTATION_RECIPE_ENUMS = Object.freeze({
  schemaVersion: PRESENTATION_SCHEMA_VERSION,
  lenses: LENSES,
  densities: DENSITIES,
  regions: REGIONS,
});
