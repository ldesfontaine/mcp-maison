// Valeurs d'exemple qu'on oublie de remplacer en copiant .env.example ou la doc : refusées au démarrage
// plutôt que de faire tourner un serveur avec un secret connu de tous.
const PLACEHOLDER = /remplacer|changeme|change-me|xxxx|placeholder|<[^>]*>/i;

export const isPlaceholder = (value: string) => PLACEHOLDER.test(value);

export const PLACEHOLDER_MESSAGE = 'valeur d\'exemple à remplacer par un vrai secret';
