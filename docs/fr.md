# PurpleAir pour Gladys Assistant

Connecteur non officiel, sans lien avec PurpleAir, Inc. Il amène dans Gladys
les mesures de vos capteurs de qualité de l'air
[PurpleAir](https://www2.purpleair.com/), en lecture seule : rien n'est
jamais modifié sur un capteur.

> Cette intégration n'a jamais été testée avec un vrai capteur PurpleAir ni
> une vraie clé API pour l'instant. Vos retours sont les bienvenus sur le
> forum de Gladys.

## Ce que vous obtenez

Pour chaque capteur, un appareil dans l'onglet Découverte avec :

| Fonction                     | Catégorie                   | Unité |
| ---------------------------- | --------------------------- | ----- |
| PM2.5                        | Capteur PM2.5               | µg/m³ |
| PM10                         | Capteur PM10                | µg/m³ |
| AQI (US EPA, PM2.5)          | Capteur de qualité de l'air | AQI   |
| Température (capteur)        | Capteur de température      | °C    |
| Humidité (capteur)           | Capteur d'humidité          | %     |
| Pression (capteurs avec BME) | Capteur de pression         | hPa   |

- PM2.5 et PM10 : la moyenne des deux lasers (canaux A et B) quand le
  capteur en a deux ; la correction `ATM` en extérieur, `CF=1` en intérieur,
  comme le fait l'API PurpleAir.
- AQI : l'indice américain de l'EPA calculé à partir des PM2.5 du moment,
  avec les seuils de la révision de 2024 (indicatif : l'indice officiel
  utilise des moyennes sur 24 heures).
- La température et l'humidité sont mesurées **dans le capteur** : la
  température y est de quelques degrés au-dessus de l'air extérieur,
  l'humidité de quelques points en dessous. Elles sont publiées telles
  quelles, sans correction.
- Les PM1 sont affichées par le bouton de test mais pas publiées : Gladys
  n'a pas encore de catégorie PM1.

## Mode local (conseillé, gratuit)

Chaque capteur PurpleAir sert ses mesures sur votre réseau
(`http://<adresse du capteur>/json`). Sans compte, sans clé, sans coût.

1. Donnez au capteur une adresse IP fixe dans votre box (réservation DHCP).
2. Saisissez cette adresse dans « Adresse du capteur (local) » (jusqu'à trois
   capteurs).
3. Gardez l'intervalle par défaut de 2 minutes (le capteur fait ses
   moyennes sur 2 minutes), ou choisissez jusqu'à 60.

L'intégration reconnaît un capteur à son adresse MAC : si la box donne son
adresse à un autre capteur, celui-ci devient un nouvel appareil et le premier
ne reçoit aucune de ses valeurs.

## Mode cloud (facultatif, payant)

Pour un capteur hors de votre réseau (le capteur d'un voisin sur la carte,
un capteur dans une autre maison). L'API officielle PurpleAir fait payer des
**points** à chaque appel, achetés à PurpleAir.

1. Créez une clé API sur [develop.purpleair.com](https://develop.purpleair.com/)
   (une clé de **LECTURE**) et saisissez-la dans « Clé API (lecture) ».
2. Trouvez l'index du capteur sur la [carte PurpleAir](https://map.purpleair.com/) :
   cliquez sur le capteur, le nombre après `select=` dans le lien est son
   index.
3. Pour un capteur privé, saisissez aussi sa clé de lecture.
4. L'intervalle est de **60 minutes par défaut** (10 minutes au minimum) :
   chaque appel coûte des points pour chaque champ demandé. Seuls les
   champs publiés sont demandés (nom, modèle, dernière remontée, PM1, PM2.5,
   PM10, température, humidité, pression).

La clé API est gardée par Gladys dans sa base, jamais réaffichée, et envoyée
seulement à l'API PurpleAir (`api.purpleair.com`) dans un en-tête, jamais
dans un lien ni dans les journaux. La clé de lecture d'un capteur privé est
gardée de la même façon ; l'API la demande dans le lien de la requête, qui
n'est jamais journalisé.

## Rythme et erreurs

- Rien ne lit un capteur (ni n'appelle l'API) plus tôt que son intervalle :
  ni le bouton de test, ni l'onglet Découverte, ni une reconnexion, ni une
  configuration enregistrée, ni un redémarrage du conteneur. L'heure de la
  dernière requête est gardée dans `/data` (écrite au plus une fois par
  minute).
- Un capteur ou l'API qui répond 429 ou 5xx : une pause (Retry-After, sinon
  5 minutes qui doublent, de 1 minute à 6 heures), gardée après un
  redémarrage ; le bouton de test l'attend aussi.
- Une clé API refusée, ou un compte sans points : plus d'appel au cloud
  pendant 6 heures (ou jusqu'au changement de clé) ; le bouton de test
  réessaie une fois l'intervalle écoulé. Les capteurs locaux continuent.
- Un index de capteur inconnu ou un capteur privé refusé : plus d'appel pour
  ce capteur pendant 6 heures (ou jusqu'au changement de sa clé de lecture).
- Un capteur cloud dont PurpleAir n'a pas de nouvelles depuis une heure ne
  publie rien (« hors ligne »).

## Bouton de test

« Tester les capteurs » lit chaque capteur dont l'intervalle est écoulé et
affiche les dernières valeurs (PM1 comprises) et l'heure de la prochaine
lecture possible.

## Remerciements

Le client cloud suit [aiopurpleair](https://github.com/bachya/aiopurpleair)
(MIT, Aaron Bach), la bibliothèque qu'utilise Home Assistant : endpoint,
en-tête de la clé, codes d'erreur. Voir `THIRD_PARTY_NOTICES.md`.
