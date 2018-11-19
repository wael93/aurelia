import { INodeSequence, INode, IText, IDocumentFragment, IRenderLocation, DOM } from '@aurelia/runtime';
import { PLATFORM, Writable, Constructable } from '@aurelia/kernel';

function isRenderLocation(node: INode): node is IRenderLocation {
  return node.textContent === 'au-end';
}

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_FRAGMENT_NODE = 11;

// This is an implementation of INodeSequence that represents "no DOM" to render.
// It's used in various places to avoid null and to encode
// the explicit idea of "no view".
const emptySequence: INodeSequence = {
  firstChild: null,
  lastChild: null,
  childNodes: PLATFORM.emptyArray,
  findTargets(): ReturnType<INodeSequence['findTargets']> { return PLATFORM.emptyArray; },
  insertBefore(refNode: INode): ReturnType<INodeSequence['insertBefore']> { /*do nothing*/ },
  appendTo(parent: INode): ReturnType<INodeSequence['appendTo']> { /*do nothing*/ },
  remove(): ReturnType<INodeSequence['remove']> { /*do nothing*/ }
};

export const NodeSequence = {
  empty: emptySequence
};

/**
 * An specialized INodeSequence with optimizations for text (interpolation) bindings
 * The contract of this INodeSequence is:
 * - the previous element is an `au-marker` node
 * - text is the actual text node
 */
export class TextNodeSequence implements INodeSequence {
  public firstChild: IText;
  public lastChild: IText;
  public childNodes: IText[];

  private targets: [INode];

  constructor(text: IText) {
    this.firstChild = text;
    this.lastChild = text;
    this.childNodes = [text];
    this.targets = [new AuMarker(text)];
  }

  public findTargets(): ArrayLike<INode> {
    return this.targets;
  }

  public insertBefore(refNode: INode): void {
    (<any>refNode).parentNode.insertBefore(this.firstChild, refNode);
  }

  public appendTo(parent: INode): void {
    (<any>parent).appendChild(this.firstChild);
  }

  public remove(): void {
    (<any>this.firstChild).remove();
  }
}
// tslint:enable:no-any

// This is the most common form of INodeSequence.
// Every custom element or template controller whose node sequence is based on an HTML template
// has an instance of this under the hood. Anyone who wants to create a node sequence from
// a string of markup would also receive an instance of this.
// CompiledTemplates create instances of FragmentNodeSequence.
/*@internal*/
export class FragmentNodeSequence implements INodeSequence {
  public firstChild: INode;
  public lastChild: INode;
  public childNodes: INode[];

  private fragment: IDocumentFragment;
  private targets: ArrayLike<INode>;

  private start: IRenderLocation;
  private end: IRenderLocation;

  constructor(fragment: IDocumentFragment) {
    this.fragment = fragment;
    // tslint:disable-next-line:no-any
    const targetNodeList = (<any>fragment).querySelectorAll('.au');
    let i = 0;
    let ii = targetNodeList.length;
    const targets = this.targets = Array(ii);
    while (i < ii) {
      // eagerly convert all markers to IRenderLocations (otherwise the renderer
      // will do it anyway) and store them in the target list (since the comments
      // can't be queried)
      const target = targetNodeList[i];
      if (target.nodeName === 'AU-MARKER') {
        // note the renderer will still call this method, but it will just return the
        // location if it sees it's already a location
        targets[i] = DOM.convertToRenderLocation(target);
      } else {
        // also store non-markers for consistent ordering
        targets[i] = target;
      }
      ++i;
    }
    const childNodeList = fragment.childNodes;
    i = 0;
    ii = childNodeList.length;
    const childNodes = this.childNodes = Array(ii);
    while (i < ii) {
      childNodes[i] = childNodeList[i] as Writable<INode>;
      ++i;
    }

    this.firstChild = fragment.firstChild;
    this.lastChild = fragment.lastChild;

    this.start = this.end = null;
  }

  public findTargets(): ArrayLike<INode> {
    // tslint:disable-next-line:no-any
    return this.targets;
  }

  public insertBefore(refNode: IRenderLocation): void {
    // tslint:disable-next-line:no-any
    (<any>refNode).parentNode.insertBefore(this.fragment, refNode);
    // internally we could generally assume that this is an IRenderLocation,
    // but since this is also public API we still need to double check
    // (or horrible things might happen)
    if (isRenderLocation(refNode)) {
      this.end = refNode;
      const start = this.start = refNode.$start;
      if (start.$nodes === null) {
        start.$nodes = this;
      } else {
        // if more than one NodeSequence uses the same RenderLocation, it's an child
        // of a repeater (or something similar) and we shouldn't remove all nodes between
        // start - end since that would always remove all items from a repeater, even
        // when only one is removed
        // so we set $nodes to PLATFORM.emptyObject to 1) tell other sequences that it's
        // occupied and 2) prevent start.$nodes === this from ever evaluating to true
        // during remove()
        start.$nodes = PLATFORM.emptyObject;
      }
    }
  }

  public appendTo(parent: INode): void {
    // tslint:disable-next-line:no-any
    (<any>parent).appendChild(this.fragment);
    // this can never be a RenderLocation, and if for whatever reason we moved
    // from a RenderLocation to a host, make sure "start" and "end" are null
    this.start = this.end = null;
  }

  public remove(): void {
    const fragment = this.fragment;
    if (this.start !== null && this.start.$nodes === this) {
      // if we're between a valid "start" and "end" (e.g. if/else, containerless, or a
      // repeater with a single item) then simply remove everything in-between (but not
      // the comments themselves as they belong to the parent)
      const end = this.end;
      let next: INode;
      let current = this.start.nextSibling;
      while (current !== end) {
        next = current.nextSibling;
        // tslint:disable-next-line:no-any
        (<any>fragment).appendChild(current);
        current = next;
      }
      this.start.$nodes = null;
      this.start = this.end = null;
    } else {
      // otherwise just remove from first to last child in the regular way
      let current = this.firstChild;

      if (current.parentNode !== fragment) {
        const end = this.lastChild;
        let next: INode;

        while (current !== null) {
          next = current.nextSibling;
          // tslint:disable-next-line:no-any
          (<any>fragment).appendChild(current);

          if (current === end) {
            break;
          }

          current = next;
        }
      }
    }
  }
}

interface ICloneableNode extends INode {
  cloneNode(deep?: boolean): ICloneableNode;
}

export interface INodeSequenceFactory {
  createNodeSequence(): INodeSequence;
}

export class PixiNodeSequenceFactory {
  private readonly deepClone: boolean;
  private readonly node: ICloneableNode;
  private readonly Type: Constructable;
  constructor(fragment: IDocumentFragment) {
    const childNodes = fragment.childNodes;
    switch (childNodes.length) {
      case 0:
        this.createNodeSequence = () => NodeSequence.empty;
        return;
      case 2:
        const target = childNodes[0];
        if (target.nodeName === 'AU-MARKER' || target.nodeName === '#comment') {
          const text = childNodes[1];
          if (text.nodeType === TEXT_NODE && text.textContent === ' ') {
            text.textContent = '';
            this.deepClone = false;
            this.node = <ICloneableNode>text;
            this.Type = TextNodeSequence;
            return;
          }
        }
      // falls through if not returned
      default:
        this.deepClone = true;
        this.node = <ICloneableNode>fragment;
        this.Type = FragmentNodeSequence;
    }
  }

  public static createFor(markupOrNode: string | INode): PixiNodeSequenceFactory {
    const fragment = DOM.createDocumentFragment(markupOrNode);
    return new PixiNodeSequenceFactory(fragment);
  }

  public createNodeSequence(): INodeSequence {
    return new this.Type(this.node.cloneNode(this.deepClone));
  }
}

/*@internal*/
export class AuMarker implements INode {
  public get parentNode(): INode {
    return this.nextSibling.parentNode;
  }
  public readonly nextSibling: INode;
  public readonly previousSibling: INode;
  public readonly content?: INode;
  public readonly firstChild: INode;
  public readonly lastChild: INode;
  public readonly childNodes: ArrayLike<INode>;
  public readonly nodeName: 'AU-MARKER';
  public readonly nodeType: typeof ELEMENT_NODE;
  public textContent: string = '';

  constructor(next: INode) {
    this.nextSibling = next;
  }
  public remove(): void { /* do nothing */ }
}
(proto => {
  proto.previousSibling = null;
  proto.firstChild = null;
  proto.lastChild = null;
  proto.childNodes = PLATFORM.emptyArray;
  proto.nodeName = 'AU-MARKER';
  proto.nodeType = ELEMENT_NODE;
})(<Writable<AuMarker>>AuMarker.prototype);
