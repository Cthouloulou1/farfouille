"""
Compile dictionnaire.txt -> DAWG minimal, serialise en binaire plat.

Algorithme : minimisation incrementale (Daciuk, Mihov, Watson & Watson 2000).
Elle exige une entree triee -- ce que dictionnaire.txt est deja.

Format de sortie (packages/engine/data/dawg.bin) :
    en-tete  : magic "DAWG" | uint32 nbNoeuds | uint32 nbAretes | uint32 racine
    aretes   : uint32 chacune, les aretes d'un noeud etant contigues
               bits  0-24 : index de la premiere arete du noeud cible
               bit     25 : le noeud cible est terminal (fin de mot)
               bit     26 : derniere arete de ce noeud
               bits 27-31 : lettre, 1..26 pour A..Z, 27 pour le separateur GADDAG
Un noeud est donc simplement l'index de sa premiere arete ; 0 = aucune arete.
Les aretes d'un noeud sont contigues et TRIEES PAR CODE de lettre.
"""
import sys, struct, time
from pathlib import Path

SEP = '#'                      # separateur GADDAG, code 27
CODE = {c: i + 1 for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ")}
CODE[SEP] = 27


class Node:
    __slots__ = ("final", "edges", "_h", "id")
    _next = 0

    def __init__(self):
        self.final = False
        self.edges = {}
        self._h = None
        Node._next += 1
        self.id = Node._next

    def key(self):
        return (self.final, tuple(sorted((c, n.id) for c, n in self.edges.items())))

    def __hash__(self):
        if self._h is None:
            self._h = hash(self.key())
        return self._h

    def __eq__(self, o):
        return self.key() == o.key()


class Builder:
    def __init__(self):
        self.root = Node()
        self.unchecked = []
        self.minimized = {}
        self.prev = ""

    def add(self, word):
        # l'entree doit etre triee
        i = 0
        m = min(len(word), len(self.prev))
        while i < m and word[i] == self.prev[i]:
            i += 1
        self._minimize(i)
        node = self.unchecked[-1][2] if self.unchecked else self.root
        for ch in word[i:]:
            nxt = Node()
            node.edges[ch] = nxt
            self.unchecked.append((node, ch, nxt))
            node = nxt
        node.final = True
        self.prev = word

    def finish(self):
        self._minimize(0)
        return self.root

    def _minimize(self, down_to):
        for _ in range(len(self.unchecked) - down_to):
            parent, ch, child = self.unchecked.pop()
            seen = self.minimized.get(child)
            if seen is not None:
                parent.edges[ch] = seen
            else:
                self.minimized[child] = child


def serialize(root, out_path):
    """Parcours en largeur, chaque noeud recoit un bloc d'aretes contigu."""
    order, seen = [], {id(root): None}
    stack = [root]
    while stack:
        n = stack.pop()
        order.append(n)
        for ch in sorted(n.edges):
            c = n.edges[ch]
            if id(c) not in seen:
                seen[id(c)] = None
                stack.append(c)

    # attribue a chaque noeud l'index de sa premiere arete (0 = feuille)
    first, cursor = {}, 1
    for n in order:
        if n.edges:
            first[id(n)] = cursor
            cursor += len(n.edges)
        else:
            first[id(n)] = 0

    edges = [0] * cursor
    for n in order:
        if not n.edges:
            continue
        # INVARIANT : les aretes d'un noeud sont triees par CODE de lettre
        # (A..Z = 1..26, separateur = 27), pas par caractere. Le separateur '#'
        # vaut 0x23 en ASCII et passerait avant 'A' avec un tri naturel, ce qui
        # casserait la sortie anticipee du parcours cote TypeScript.
        items = sorted(n.edges.items(), key=lambda kv: CODE[kv[0]])
        base = first[id(n)]
        for k, (ch, tgt) in enumerate(items):
            w = first[id(tgt)] & 0x1FFFFFF
            if tgt.final:
                w |= 1 << 25
            if k == len(items) - 1:
                w |= 1 << 26
            w |= CODE[ch] << 27
            edges[base + k] = w

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(b"DAWG")
        f.write(struct.pack("<III", len(order), cursor, first[id(root)]))
        f.write(struct.pack(f"<{cursor}I", *edges))
    return len(order), cursor


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "dictionnaire.txt")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "packages/engine/data/dawg.bin")

    t0 = time.time()
    words = [w.strip() for w in open(src, encoding="ascii") if w.strip()]
    b = Builder()
    for w in words:
        b.add(w)
    root = b.finish()
    t1 = time.time()
    nodes, edges = serialize(root, out)
    t2 = time.time()

    size = out.stat().st_size
    print(f"mots          : {len(words):>10,}")
    print(f"noeuds        : {nodes:>10,}")
    print(f"aretes        : {edges:>10,}")
    print(f"fichier       : {size/1e6:>10.2f} Mo   ({out})")
    print(f"construction  : {t1-t0:>10.1f} s")
    print(f"serialisation : {t2-t1:>10.1f} s")


if __name__ == "__main__":
    main()
