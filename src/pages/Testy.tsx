import {useSortable} from '@dnd-kit/react/sortable';

function Testy({id, index} : {id: number, index: number}) {
  const {ref} = useSortable({id, index});

  return (
    <li ref={ref} className="bg-white p-10 rounded-2xl">Item {id}</li>
  );
}

export default Testy;

