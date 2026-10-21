// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why a sensor has no fresh value. */
export const REASONS = {
  refused: { en: 'API key refused', fr: 'clé API refusée' },
  credits: { en: 'no API points left', fr: "plus de points sur l'API" },
  busy: { en: 'busy (pause)', fr: 'occupé (pause)' },
  not_found: { en: 'unknown sensor index', fr: 'index de capteur inconnu' },
  denied: {
    en: 'sensor refused (private? check the read key)',
    fr: 'capteur refusé (privé ? vérifiez la clé de lecture)',
  },
  offline: { en: 'sensor offline for PurpleAir', fr: 'capteur hors ligne pour PurpleAir' },
  invalid: { en: 'not a PurpleAir answer', fr: "réponse qui n'est pas celle d'un PurpleAir" },
  channels: {
    en: 'channels A/B disagree (particles and AQI not published)',
    fr: 'canaux A/B en désaccord (particules et AQI non publiés)',
  },
  duplicate: {
    en: 'same sensor as another address',
    fr: "même capteur qu'une autre adresse",
  },
  failed: { en: 'no answer', fr: 'pas de réponse' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

const INVALID = {
  address: { en: 'address not understood', fr: 'adresse non comprise' },
  duplicate: { en: 'entered twice', fr: 'saisi deux fois' },
  key: { en: 'API key not understood', fr: 'clé API non comprise' },
  index: { en: 'sensor index not understood', fr: 'index de capteur non compris' },
  readKey: { en: 'read key not understood', fr: 'clé de lecture non comprise' },
  noKey: { en: 'API key missing', fr: 'clé API manquante' },
};

const slotName = (slot, lang) =>
  slot === 'API'
    ? 'API'
    : lang === 'fr'
      ? slot.replace(/^local/, 'Capteur local').replace(/^cloud/, 'Capteur cloud')
      : slot.replace(/^local/, 'Local sensor').replace(/^cloud/, 'Cloud sensor');

export const T = {
  notConfigured: {
    en: 'Enter the IP address of a PurpleAir sensor on your network (free), or an API key and a sensor index.',
    fr: "Saisissez l'adresse IP d'un capteur PurpleAir de votre réseau (gratuit), ou une clé API et un index de capteur.",
  },
  invalidSlots: (invalid) => ({
    en: invalid.map((i) => `${slotName(i.slot, 'en')} ignored: ${INVALID[i.why].en}`).join('. '),
    fr: invalid.map((i) => `${slotName(i.slot, 'fr')} ignoré : ${INVALID[i.why].fr}`).join('. '),
  }),
  refusedHelp: {
    en: 'A refused API key stops the cloud reads: check the key in develop.purpleair.com; one new try every 6 hours until it changes.',
    fr: "Une clé API refusée arrête les lectures par le cloud : vérifiez la clé sur develop.purpleair.com ; un nouvel essai toutes les 6 heures jusqu'à ce qu'elle change.",
  },
  creditsHelp: {
    en: 'The PurpleAir account has no points left: the cloud reads stop, one new try every 6 hours (add points in develop.purpleair.com, or read the sensor on the local network, which is free).',
    fr: "Le compte PurpleAir n'a plus de points : les lectures par le cloud s'arrêtent, un nouvel essai toutes les 6 heures (ajoutez des points sur develop.purpleair.com, ou lisez le capteur sur le réseau local, ce qui est gratuit).",
  },
  channelsDisagree: (names) => ({
    en: `Channels A/B disagree, particles and AQI not published (a laser may be failing): ${names.join(', ')}`,
    fr: `Canaux A/B en désaccord, particules et AQI non publiés (un laser est peut-être en panne) : ${names.join(', ')}`,
  }),
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, and what fails. */
  ok: ({ local, cloud, localMinutes, cloudMinutes, failing = [] }) => {
    const en = [];
    const fr = [];
    if (local > 0) {
      en.push(`${local} local sensor(s), read every ${localMinutes} min`);
      fr.push(`${local} capteur(s) local(aux), lu(s) toutes les ${localMinutes} min`);
    }
    if (cloud > 0) {
      en.push(`${cloud} cloud sensor(s), read every ${cloudMinutes} min`);
      fr.push(`${cloud} capteur(s) cloud, lu(s) toutes les ${cloudMinutes} min`);
    }
    let textEn = `PurpleAir: ${en.join('; ')}.`;
    let textFr = `PurpleAir : ${fr.join(' ; ')}.`;
    if (failing.length > 0) {
      textEn += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      textFr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en: textEn, fr: textFr };
  },
};
