import { Navigate, useParams } from "react-router-dom";
import { feedAliasTarget } from "../shell/routes";

/**
 * `/feed/<card id>`: the short form of a card's address. It lands on /chat/feed/<card id>, and anything that is not a
 * card id lands on the plain Feed. The destination is built from a constant and a checked id, never from the text, and
 * `replace` keeps the short address out of history. It is not a Home entry: the owner's start screen does not apply.
 */
export function FeedCardAlias() {
  const { cardId } = useParams();
  return <Navigate to={feedAliasTarget(cardId)} replace />;
}
