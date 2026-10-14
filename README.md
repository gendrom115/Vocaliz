# Vocaliz

Une dictée intelligente pour Obsidian, pensée d'abord pour l'iPhone. Tu parles, et un texte propre apparaît là où se trouve ton curseur. Tu peux aussi demander un résumé au lieu du texte complet.

- **Dictée propre** : ta parole est transcrite puis mise au propre. Les « euh » et les répétitions disparaissent, la ponctuation est corrigée et tes reprises (« non, je veux dire… ») sont gérées.
- **Résumé** : un résumé court, des points clés ou des actions à faire, selon tes réglages. Le texte complet est ajouté juste en dessous, replié.

La transcription est faite par OpenAI (`gpt-4o-mini-transcribe`) et la réécriture par Claude (Anthropic).

## Fonctionnement

| Situation | Où va le texte |
|---|---|
| Une note est ouverte | Au curseur. S'il y a une sélection, elle est remplacée. |
| Tu as changé de note pendant le traitement | À la fin de la note où tu as commencé |
| Aucune note n'est ouverte | Dans la note du jour, sous l'heure du vocal |

L'audio est enregistré dans le coffre dès que tu arrêtes, puis **supprimé une fois le texte inséré**. En cas d'échec (pas de réseau, quota…), il reste dans `Vocaliz/En attente`. La commande **« Traiter les vocaux en attente »** le relance plus tard.

### Commandes vocales

Tu peux les dire pendant la dictée :

| Tu dis | Résultat |
|---|---|
| « à la ligne » | saut de ligne |
| « nouveau paragraphe », « point à la ligne » | nouveau paragraphe |
| « titre … » | titre |
| « liste », « puce », « tiret » | élément de liste |
| « tâche … », « case à cocher … » | `- [ ] …` |
| « ouvrez / fermez les guillemets » | « … » |

Les énumérations et les changements de sujet sont aussi mis en forme automatiquement.

## Installation sur iPhone (avec BRAT)

1. Dans Obsidian : **Réglages → Modules complémentaires** → désactive le mode restreint si besoin.
2. Installe le module **BRAT** (Obsidian42 - BRAT) depuis le catalogue, puis active-le.
3. Réglages de BRAT → **Add Beta plugin** → colle `gendrom115/vocaliz` → **Add Plugin**.
4. Active **Vocaliz** dans la liste des modules.
5. Ouvre ses réglages et colle tes deux clés API :
   - OpenAI : https://platform.openai.com/api-keys
   - Anthropic : https://console.anthropic.com/settings/keys
6. Appuie sur **Tester** pour vérifier les clés.

Les clés sont rangées dans le **trousseau d'Obsidian**, sur l'appareil. Elles ne sont pas dans ton coffre et ne se synchronisent pas, donc il faut les saisir une fois sur chaque appareil.

La première dictée demande l'accès au micro. En cas de refus : **Réglages iPhone → Obsidian → Micro**.

## Lancer une dictée vite

**Depuis Obsidian, dans la barre au-dessus du clavier :** Réglages → **Barre d'outils mobile** → ajoute « Vocaliz : Dictée propre » et « Vocaliz : Résumé vocal ». Un tap pour démarrer, un tap sur **Terminer** pour arrêter.

**Sans ouvrir Obsidian à la main (bouton Action, écran d'accueil, widget) :**

1. App **Raccourcis** → nouveau raccourci → action **Ouvrir les URL**.
2. URL : `obsidian://vocaliz?mode=dictee` (ou `mode=resume`).
3. Réglages iPhone → **Bouton Action** → Raccourci → choisis-le. Tu peux aussi l'ajouter à l'écran d'accueil ou en widget.

Obsidian s'ouvre et l'enregistrement démarre aussitôt. Sans note ouverte, le texte part dans la note du jour.

## Réglages

| Réglage | Par défaut | Rôle |
|---|---|---|
| Niveau de nettoyage | Moyen | Moyen : tes mots remis au propre. Fort : réécrit en style écrit, plus concis. |
| Format du résumé | Points clés | Résumé court, points clés ou actions à faire |
| Vocabulaire perso | vide | Noms, sigles, termes métier toujours bien orthographiés |
| Où va le texte | Au curseur, sinon note du jour | Ou : au curseur sinon nouvelle note ; ou toujours une nouvelle note |
| Dossier / nom des nouvelles notes | `Vocaliz`, `YYYY-MM-DD HHmm Vocal` | Format de date moment.js |
| Fichier modèle | vide (date + tag #vocal) | Une note de ton coffre, voir ci-dessous |
| Modèle de transcription | gpt-4o-mini-transcribe | `gpt-4o-transcribe` est un peu plus précis |
| Modèle Claude | claude-haiku-5-5 | `claude-sonnet-5-5` réécrit mieux mais un peu plus lentement |
| Durée maximale | 10 min | Arrêt automatique au-delà |

### Modèle de note

Quand le texte va dans une nouvelle note, elle est créée à partir du fichier modèle dès que tu lances l'enregistrement, et s'ouvre. Le texte s'insère à la place de `{{contenu}}` une fois le vocal traité. Si tu annules, la note est supprimée, sauf si tu y as écrit entre-temps. Variables disponibles :
`{{contenu}}` (le texte mis au propre ou le résumé), `{{transcription}}` (le texte brut), `{{date}}`, `{{time}}`, `{{title}}` (nom de la note) et `{{mode}}`.
Sans `{{contenu}}` dans le modèle, le texte est ajouté à la fin.

```markdown
---
date: {{date}} {{time}}
tags:
  - vocal
---
{{contenu}}
```

## Limites

- **iPhone :** l'enregistrement s'arrête si tu verrouilles l'écran ou quittes Obsidian. Le plugin garde l'écran allumé pendant la dictée.
- Ça ne fonctionne que dans Obsidian. Ce n'est pas un clavier système comme Wispr Flow.
- L'audio est envoyé à OpenAI et le texte à Anthropic. Évite d'y dicter des données confidentielles.
- Coût indicatif : environ 0,3 centime par minute pour la transcription, plus une fraction de centime pour Claude.

## Développement

```bash
npm install
npm run dev     # recompile à chaque modification
npm run build   # vérification TypeScript + main.js de production
```

Pour publier une version :

```bash
npm version patch   # met à jour manifest.json et versions.json
git push --follow-tags
```

L'action GitHub compile le plugin et crée la release (`main.js`, `manifest.json`, `styles.css`) que BRAT installe.

## Licence

MIT
