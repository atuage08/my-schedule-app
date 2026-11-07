// No HTML parsing. Text, form values and attributes are always separate from markup.
const TAGS=new Set('div span h1 h2 h3 p button form label input select option details summary small strong section header main footer i br'.split(' '));
const ATTRIBUTES=new Set('id class name type placeholder maxlength inputmode min max step role method'.split(' '));
const BOOLEANS=new Set(['checked','selected','disabled','required']);
export function createDom(document){
  const nodes=children=>children.flatMap(child=>{
    if(child===null||child===undefined||child===false)return [];
    if(Array.isArray(child))return nodes(child);
    if(typeof child==='string'||typeof child==='number')return [document.createTextNode(String(child))];
    if(child&&typeof child.nodeType==='number')return [child];
    throw Error('Unsupported DOM child');
  });
  function h(tag,attributes={},...children){
    if(!TAGS.has(tag))throw Error('Unsupported UI element');
    const element=document.createElement(tag);
    for(const [key,value] of Object.entries(attributes)){
      if(value===null||value===undefined)continue;
      if(BOOLEANS.has(key))element[key]=Boolean(value);
      else if(key==='value')element.value=String(value);
      else if(ATTRIBUTES.has(key)||/^aria-[a-z-]+$/.test(key)||/^data-[a-z-]+$/.test(key)){
        if(key==='method'&&value!=='dialog')throw Error('Unsupported form method');
        element.setAttribute(key,String(value));
      }else throw Error('Unsupported UI attribute');
    }
    element.append(...nodes(children));return element;
  }
  return {h,replace:(target,...children)=>target.replaceChildren(...nodes(children))};
}
