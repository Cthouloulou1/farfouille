/**
 * Chargement et parcours du DAWG / GADDAG. Voir SPEC.md §7.
 *
 * Les deux structures partagent le meme format binaire. Une arete = un uint32 :
 *   bits 0-24   index de la premiere arete du noeud cible
 *   bit    25   le noeud cible termine un mot
 *   bit    26   derniere arete de ce noeud
 *   bits 27-31  lettre (1-26 = A-Z, 27 = separateur GADDAG)
 *
 * Les aretes d'un noeud sont contigues et triees par lettre : un noeud n'est
 * donc qu'un entier, 0 signifiant "aucune arete". Aucun parsing au chargement,
 * on lit l'ArrayBuffer tel quel.
 */
import { code } from "./alphabet.ts";

export const NO_EDGE = -1;

export class Dict {
  // Pas de proprietes de constructeur : le mode strip-only de Node les refuse,
  // elles emettraient du code a l'execution. Meme raison pour enum et namespace.
  readonly edges: Uint32Array;
  readonly root: number;
  readonly nodeCount: number;

  constructor(edges: Uint32Array, root: number, nodeCount: number) {
    this.edges = edges;
    this.root = root;
    this.nodeCount = nodeCount;
  }

  /**
   * Construit depuis les octets bruts du fichier compile.
   *
   * Aucune entree-sortie ici : le moteur doit tourner tel quel dans le
   * navigateur, ou le dictionnaire arrive par le reseau. Le chargement depuis un
   * fichier vit dans dictionary_node.ts.
   */
  static fromBytes(bytes: ArrayBuffer | Uint8Array): Dict {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const magic = String.fromCharCode(u8[0]!, u8[1]!, u8[2]!, u8[3]!);
    if (magic !== "DAWG") throw new Error("magic invalide : ce n'est pas un dictionnaire compile");
    const head = new DataView(u8.buffer, u8.byteOffset, 16);
    const nodes = head.getUint32(4, true);
    const nedges = head.getUint32(8, true);
    const root = head.getUint32(12, true);
    const edges = new Uint32Array(nedges);
    const view = new DataView(u8.buffer, u8.byteOffset + 16, nedges * 4);
    for (let i = 0; i < nedges; i++) edges[i] = view.getUint32(i * 4, true);
    return new Dict(edges, root, nodes);
  }

  static target(e: number): number { return e & 0x1ffffff; }
  static isTerminal(e: number): boolean { return ((e >>> 25) & 1) === 1; }
  static isLast(e: number): boolean { return ((e >>> 26) & 1) === 1; }
  static letterCode(e: number): number { return e >>> 27; }

  /**
   * Index de l'arete portant la lettre `c` depuis `node`, ou NO_EDGE.
   * Les aretes etant triees, on sort des qu'on a depasse la lettre cherchee.
   */
  findEdge(node: number, c: number): number {
    if (node === 0) return NO_EDGE;
    const E = this.edges;
    for (let i = node; ; i++) {
      const e = E[i]!;
      const lc = e >>> 27;
      if (lc === c) return i;
      if (lc > c) return NO_EDGE;
      if (((e >>> 26) & 1) === 1) return NO_EDGE;
    }
  }

  /** Noeud atteint en suivant `c` depuis `node`, ou 0 si impossible. */
  follow(node: number, c: number): number {
    const i = this.findEdge(node, c);
    return i === NO_EDGE ? 0 : (this.edges[i]! & 0x1ffffff);
  }

  /** Le mot est-il dans le dictionnaire ? Marche aussi sur le GADDAG (rotations). */
  contains(word: string): boolean {
    let node = this.root;
    for (let i = 0; i < word.length; i++) {
      const e = this.findEdge(node, code(word[i]!));
      if (e === NO_EDGE) return false;
      if (i === word.length - 1) return Dict.isTerminal(this.edges[e]!);
      node = this.edges[e]! & 0x1ffffff;
    }
    return false;
  }
}
