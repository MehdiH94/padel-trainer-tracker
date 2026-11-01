"""Exercices proposés par l'application (coach_id = None en base). Le coach ajoute les siens à côté.

Thèmes « structurels » (Échauffement, Jeu, Retour au calme): ils servent à construire le début et la fin
d'une séance; les autres thèmes (coups, déplacements, tactique, physique) sont ceux que le coach choisit.
"""

STRUCTURE_THEMES = ["Échauffement", "Jeu", "Retour au calme"]
WORK_THEMES = [
    "Service", "Retour de service", "Volée", "Bandeja", "Víbora", "Sortie de vitre", "Smash", "Lob",
    "Défense fond de court", "Déplacements", "Tactique", "Physique",
]
THEMES = WORK_THEMES + STRUCTURE_THEMES

# (nom, description, thèmes, joueurs min, joueurs max, durée conseillée en minutes)
BUILTIN = [
    ("Mini-padel au filet", "Échanges en volée douce dans les carrés de service, balle contrôlée, sans chercher le point. Monter progressivement le rythme.", ["Échauffement", "Volée"], 1, 4, 10),
    ("Échauffement dynamique", "Trottinement, pas chassés, montées de genoux, puis échanges coup droit / revers depuis le fond, en douceur.", ["Échauffement", "Déplacements"], 1, 4, 10),
    ("Cibles au service", "Cônes au T, sur le corps et vers la grille latérale. 10 services par zone, on compte les réussites; refaire en battant son score.", ["Service"], 1, 4, 15),
    ("Service + première volée", "Servir puis monter au filet: première volée en profondeur sur le retour envoyé par le coach, puis replacement.", ["Service", "Volée", "Déplacements"], 1, 4, 15),
    ("Retour croisé dans les pieds", "Le coach sert et monte; le joueur retourne croisé, bas, dans les pieds du serveur. Viser une zone au sol.", ["Retour de service"], 1, 4, 15),
    ("Retour lobé", "Sur service, retour en lob par-dessus le joueur au filet pour reprendre l'initiative. Travail de hauteur et de profondeur.", ["Retour de service", "Lob"], 1, 4, 10),
    ("Volées en rafale", "Panier rapide alterné coup droit / revers: volée en profondeur, retour en position à chaque balle.", ["Volée", "Déplacements"], 1, 4, 15),
    ("Volée basse / volée haute", "Alterner balle dans les pieds (volée basse, genoux fléchis) et balle haute (volée de finition). Insister sur le placement des pieds.", ["Volée"], 1, 4, 15),
    ("Volley-volley", "Points joués uniquement en volée dans les carrés de service: réflexes, mains basses, balle bloquée.", ["Volée", "Tactique"], 2, 4, 10),
    ("Bandeja de contrôle", "Lob du coach; bandeja croisée vers la grille latérale, sans chercher la vitesse, puis retour au filet.", ["Bandeja"], 1, 4, 15),
    ("Bandeja puis volée", "Enchaîner une bandeja de contrôle puis une volée de finition sur la balle suivante.", ["Bandeja", "Volée", "Déplacements"], 1, 4, 15),
    ("Víbora vers la grille", "Lob côté revers: víbora avec effet latéral pour faire mourir la balle près de la vitre latérale.", ["Víbora"], 1, 4, 15),
    ("Bandeja ou víbora ?", "Le coach varie hauteur et côté du lob: le joueur choisit le bon coup et l'annonce avant de frapper.", ["Bandeja", "Víbora", "Tactique"], 1, 4, 15),
    ("Smash par 3", "Lob court au centre: smash puissant pour faire sortir la balle sur le côté (par 3) ou par-dessus la vitre (par 4).", ["Smash"], 1, 4, 15),
    ("Smash à plat dans les pieds", "Sur lob court, smash à plat dirigé vers les pieds plutôt qu'en hauteur. Puis replacement au filet.", ["Smash", "Déplacements"], 1, 4, 10),
    ("Lob de défense en profondeur", "Depuis le fond, lob haut qui rebondit près de la vitre du fond adverse. Viser une zone de 2 m devant la vitre.", ["Lob", "Défense fond de court"], 1, 4, 15),
    ("Lob ou chiquita", "Contre des joueurs au filet, alterner lob et balle basse lente (chiquita) dans les pieds. Le coach annonce, puis le joueur choisit.", ["Lob", "Tactique"], 2, 4, 15),
    ("Sortie de vitre de fond", "Balles qui rebondissent sur la vitre du fond: laisser passer, se retourner, remonter la balle en lob ou en balle basse.", ["Sortie de vitre", "Défense fond de court"], 1, 4, 15),
    ("Double vitre", "Balles qui touchent fond puis latérale (ou l'inverse): lecture de la trajectoire et placement avant la frappe.", ["Sortie de vitre", "Déplacements"], 1, 4, 15),
    ("Défense contre le smash", "Le coach smashe depuis le filet: se placer près de la vitre, récupérer après rebond, remettre en lob.", ["Défense fond de court", "Lob"], 1, 4, 10),
    ("Contre-attaque après la vitre", "Après une sortie de vitre, frapper en attaque: balle basse croisée ou passing le long de la grille.", ["Sortie de vitre", "Tactique"], 1, 4, 15),
    ("Circuit pas chassés", "Parcours de cônes avec une frappe à chaque cône et replacement au centre. 3 passages par joueur.", ["Déplacements", "Physique"], 1, 4, 10),
    ("Montée au filet en duo", "Sur un lob court ou une balle facile, la paire monte ensemble au filet en restant à la même hauteur.", ["Déplacements", "Tactique"], 2, 4, 15),
    ("Jouer au centre", "Points où l'on vise le milieu entre les deux adversaires pour créer l'hésitation. Bonus si la balle passe au centre.", ["Tactique"], 2, 4, 15),
    ("Reprendre le filet", "L'équipe du fond doit lober pour reprendre le filet; le point ne compte que si elle y parvient.", ["Tactique", "Lob"], 2, 4, 15),
    ("Fractionné sur la piste", "30 s d'effort (sprints latéraux, fentes, montées au filet) / 30 s de récupération, 6 répétitions.", ["Physique", "Déplacements"], 1, 4, 10),
    ("Panier en fatigue", "Panier à rythme élevé, 45 s par joueur, balles variées dans toute la piste.", ["Physique", "Volée", "Défense fond de court"], 1, 4, 10),
    ("Match à thème", "Points normaux; le point vaut double si le coup travaillé dans la séance est réussi.", ["Jeu"], 2, 4, 15),
    ("Américaine express", "Points courts, rotation des paires toutes les 4 minutes.", ["Jeu"], 3, 4, 15),
    ("Jeu en diagonale", "1 contre 1 sur une moitié de piste en diagonale: consistance et placement.", ["Jeu"], 2, 4, 10),
    ("Jeu dirigé contre le coach", "Points joués contre le coach qui impose des situations liées au thème de la séance.", ["Jeu"], 1, 1, 10),
    ("Retour au calme", "Étirements, respiration, et bilan de la séance avec les joueurs: ce qui a progressé, ce qui reste à travailler.", ["Retour au calme"], 1, 4, 5),
]
