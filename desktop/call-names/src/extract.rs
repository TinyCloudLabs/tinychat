//! Runs one app's rules over one window.
//!
//! [`Scan::read`] walks the window once for structure only (role, subrole, identifier, children),
//! skipping pruned subtrees. The rules then run over that scan. Text is requested lazily and at
//! most once per node and attribute:
//! - title and description only of nodes whose structure already matches a matcher with a label
//!   list (landmarks, the controls of the in-call check, list rows);
//! - the name attributes only of nodes a path ends on;
//! - values only of the self-marker candidates inside a matched row.
//!
//! A step's `has` condition (a node of some role a few levels below) is answered from the scan
//! alone, and before any label of that node is read: a list child that is not a participant row
//! costs no text read at all.
//!
//! An element that the walk meets a second time (a toolbar whose children lead back to the window,
//! or one element under two parents) is skipped: it is counted against the node budget, but it is
//! not read again and not attached again.
//!
//! The local user is marked only on strong evidence, because a guest chooses their own display
//! name: the text that shows the name never counts as the marker, and a source that shows more
//! than one "self" in a tick marks nobody in that tick.
//!
//! Nodes are kept in document order, so a node's subtree is the index range `index..end`.

use crate::names::{split_suffix_tags, Name, MAX_PEOPLE};
use crate::rules::{App, AppRules, Axis, Has, Matcher, SelfMarker, SourceRule, Step};
use crate::session::{Discard, Meter};
use crate::tree::{Node, Source, Structure, TextAttr};
use std::collections::HashMap;

/// A name found in one place, and whether the window marked it as the local user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: Name,
    pub is_self: bool,
}

/// The names one source rule found, in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceNames {
    pub id: String,
    /// The source is a participant list (see `SourceRule::one_per_person`).
    pub one_per_person: bool,
    pub entries: Vec<Entry>,
}

/// Everything one tick found in one window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Extraction {
    pub app: App,
    /// One per source rule, in rule order.
    pub sources: Vec<SourceNames>,
    /// A source had more than [`MAX_PEOPLE`] names; the rest were not read.
    pub truncated: bool,
}

impl Extraction {
    pub fn source(&self, id: &str) -> Option<&SourceNames> {
        self.sources.iter().find(|source| source.id == id)
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.sources.iter().flat_map(|source| source.entries.iter())
    }

    pub fn is_empty(&self) -> bool {
        self.entries().next().is_none()
    }
}

struct ScanNode<H> {
    handle: H,
    structure: Structure,
    children: Vec<usize>,
    /// One past the last node of this subtree.
    end: usize,
    /// Text cache, by [`slot`]: `None` = not read yet.
    texts: [Option<Option<String>>; 3],
}

fn slot(attr: TextAttr) -> usize {
    match attr {
        TextAttr::Title => 0,
        TextAttr::Description => 1,
        TextAttr::Value => 2,
    }
}

/// The structure of one window, read once per tick.
pub struct Scan<H> {
    app: App,
    nodes: Vec<ScanNode<H>>,
    text_reads: usize,
}

impl<H: Clone> Scan<H> {
    /// Walk the window from `root` for structure, within the meter's limits.
    pub fn read<S: Source<Node = H>>(
        source: &mut S,
        root: H,
        rules: &AppRules,
        meter: &mut Meter,
    ) -> Result<Scan<H>, Discard> {
        let mut scan = Scan {
            app: rules.app,
            nodes: Vec::new(),
            text_reads: 0,
        };
        let mut seen: HashMap<u64, Vec<usize>> = HashMap::new();
        let mut stack: Vec<(H, Option<usize>, usize)> = vec![(root, None, 0)];
        while let Some((handle, parent, depth)) = stack.pop() {
            meter.visit(depth)?;
            let hash = source.identity_hash(&handle);
            let earlier = seen.get(&hash).map(Vec::as_slice).unwrap_or_default();
            if earlier
                .iter()
                .any(|&index| source.same(&scan.nodes[index].handle, &handle))
            {
                // Met before: counted above, never read or attached twice.
                continue;
            }
            // One child more than the budget has room for is enough to overrun it.
            let room = meter.remaining_nodes().saturating_add(1);
            let (structure, children) = source
                .structure_capped(&handle, room)
                .map_err(Discard::Read)?;
            meter.check_time()?;
            let index = scan.nodes.len();
            seen.entry(hash).or_default().push(index);
            scan.nodes.push(ScanNode {
                handle,
                structure,
                children: Vec::new(),
                end: 0,
                texts: Default::default(),
            });
            if let Some(parent) = parent {
                scan.nodes[parent].children.push(index);
            }
            if scan.matches_any(source, index, &rules.prune, meter)? {
                continue;
            }
            for child in children.into_iter().rev() {
                stack.push((child, Some(index), depth + 1));
            }
        }
        for index in (0..scan.nodes.len()).rev() {
            scan.nodes[index].end = match scan.nodes[index].children.last() {
                Some(&last) => scan.nodes[last].end,
                None => index + 1,
            };
        }
        Ok(scan)
    }

    pub fn app(&self) -> App {
        self.app
    }

    /// Nodes in the scan.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Text reads sent to the source so far.
    pub fn text_reads(&self) -> usize {
        self.text_reads
    }

    /// True when the app's in-call path reaches a node (or the app has none).
    pub fn in_call<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        rules: &AppRules,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        if rules.in_call.is_empty() {
            return Ok(true);
        }
        Ok(!self.eval_path(source, &rules.in_call, meter)?.is_empty())
    }

    /// Run every source rule of the app.
    pub fn extract<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        rules: &AppRules,
        meter: &mut Meter,
    ) -> Result<Extraction, Discard> {
        let mut out = Extraction {
            app: rules.app,
            sources: Vec::new(),
            truncated: false,
        };
        for rule in &rules.sources {
            let mut entries = Vec::new();
            for (index, anchor) in self.eval_path(source, &rule.path, meter)? {
                if entries.len() == MAX_PEOPLE {
                    out.truncated = true;
                    break;
                }
                if let Some(entry) = self.read_entry(source, rule, index, anchor, meter)? {
                    entries.push(entry);
                }
            }
            // One window has one local user. Two "self" marks mean a guest's name imitates the
            // mark, so this source marks nobody in this tick.
            if entries.iter().filter(|entry| entry.is_self).count() > 1 {
                entries.iter_mut().for_each(|entry| entry.is_self = false);
            }
            out.sources.push(SourceNames {
                id: rule.id.clone(),
                one_per_person: rule.one_per_person,
                entries,
            });
        }
        Ok(out)
    }

    /// The scanned structure with the texts read so far (nothing else is known).
    pub fn to_node(&self) -> Option<Node> {
        (!self.nodes.is_empty()).then(|| self.build(0))
    }

    fn build(&self, index: usize) -> Node {
        let node = &self.nodes[index];
        let text = |attr: TextAttr| node.texts[slot(attr)].clone().flatten();
        Node {
            role: node.structure.role.clone(),
            subrole: node.structure.subrole.clone(),
            identifier: node.structure.identifier.clone(),
            title: text(TextAttr::Title),
            description: text(TextAttr::Description),
            value: text(TextAttr::Value),
            url: None,
            children: node
                .children
                .iter()
                .map(|&child| self.build(child))
                .collect(),
        }
    }

    /// Nodes reached by a path from the root, each with the node the previous step matched.
    fn eval_path<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        steps: &[Step],
        meter: &mut Meter,
    ) -> Result<Vec<(usize, Option<usize>)>, Discard> {
        let mut current: Vec<(usize, Option<usize>)> = if self.nodes.is_empty() {
            Vec::new()
        } else {
            vec![(0, None)]
        };
        for step in steps {
            let mut next: Vec<(usize, Option<usize>)> = Vec::new();
            let mut taken = vec![false; self.nodes.len()];
            for &(from, _) in &current {
                let mut found = Vec::new();
                match step.find {
                    Axis::Itself => {
                        if self.step_matches(source, from, step, meter)? {
                            found.push(from);
                        }
                    }
                    Axis::Child | Axis::FirstChild => {
                        for child in self.nodes[from].children.clone() {
                            if self.step_matches(source, child, step, meter)? {
                                found.push(child);
                                if step.find == Axis::FirstChild {
                                    break;
                                }
                            }
                        }
                    }
                    Axis::Descendant => {
                        let (mut index, end) = (from + 1, self.nodes[from].end);
                        while index < end {
                            if self.matches_any(source, index, &step.skip, meter)? {
                                index = self.nodes[index].end;
                                continue;
                            }
                            if self.step_matches(source, index, step, meter)? {
                                found.push(index);
                            }
                            index += 1;
                        }
                    }
                }
                for index in found {
                    if !std::mem::replace(&mut taken[index], true) {
                        next.push((index, Some(from)));
                    }
                }
            }
            next.sort_by_key(|&(index, _)| index);
            current = next;
            if current.is_empty() {
                break;
            }
        }
        Ok(current)
    }

    fn read_entry<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        rule: &SourceRule,
        index: usize,
        anchor: Option<usize>,
        meter: &mut Meter,
    ) -> Result<Option<Entry>, Discard> {
        let texts = self.texts(source, index, &rule.name.from, meter)?;
        let Some(raw) = texts
            .into_iter()
            .flatten()
            .find(|text| !text.trim().is_empty())
        else {
            return Ok(None);
        };
        let mut text = raw.trim();
        let mut is_self = false;
        if let Some(tags) = &rule.name.suffix_tags {
            let (rest, tagged) = split_suffix_tags(text, &tags.tags, &tags.self_tags);
            text = rest.trim();
            is_self |= tagged;
        }
        let Some(name) = Name::clean(text) else {
            return Ok(None);
        };
        if rule.name.ignore.iter().any(|word| word == name.as_str()) {
            return Ok(None);
        }
        if let Some(attr) = rule.name.prefix_of_previous {
            let Some(anchor) = anchor else {
                return Ok(None);
            };
            let whole = self.texts(source, anchor, &[attr], meter)?.pop().flatten();
            let starts = whole.as_deref().map(str::trim).is_some_and(|whole| {
                whole == text
                    || whole
                        .strip_prefix(text)
                        .is_some_and(|rest| rest.starts_with(", "))
            });
            if !starts {
                return Ok(None);
            }
        }
        if let Some(marker) = &rule.self_marker {
            is_self |= self.has_marker(source, index, marker, text, meter)?;
        }
        Ok(Some(Entry { name, is_self }))
    }

    /// True when a marker text sits beside the name. A row shows its name as a text of its own,
    /// so when the name itself reads like the marker (a guest called "(You)"), that text is not
    /// the marker: a second one must be there.
    fn has_marker<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        marker: &SelfMarker,
        name: &str,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        let needed = if marker.value.iter().any(|want| want == name) {
            2
        } else {
            1
        };
        let mut found = 0;
        let candidates: Vec<usize> = match marker.find {
            Axis::Child => self.nodes[index].children.clone(),
            Axis::Descendant => (index + 1..self.nodes[index].end).collect(),
            Axis::Itself | Axis::FirstChild => Vec::new(),
        };
        for candidate in candidates {
            let role = self.nodes[candidate].structure.role.as_deref();
            if !marker.role.iter().any(|want| Some(want.as_str()) == role) {
                continue;
            }
            let value = self
                .texts(source, candidate, &[TextAttr::Value], meter)?
                .pop()
                .flatten();
            if value.is_some_and(|value| marker.value.iter().any(|want| want == value.trim())) {
                found += 1;
                if found == needed {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn matches_any<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        matchers: &[Matcher],
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        for matcher in matchers {
            if self.matches(source, index, matcher, meter)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// A path step: the node's own structure, then what must lie below it, then its label. Only
    /// the last one reads text, and only when the first two hold.
    fn step_matches<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        step: &Step,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        if !self.structure_matches(index, &step.matcher) {
            return Ok(false);
        }
        if step
            .has
            .as_ref()
            .is_some_and(|has| !self.has_below(index, has))
        {
            return Ok(false);
        }
        self.label_matches(source, index, &step.matcher, meter)
    }

    /// Structure first; title and description only when the structure matched and a label list
    /// is set.
    fn matches<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        matcher: &Matcher,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        if !self.structure_matches(index, matcher) {
            return Ok(false);
        }
        self.label_matches(source, index, matcher, meter)
    }

    /// Role, subrole and identifier: answered from the scan, no read.
    fn structure_matches(&self, index: usize, matcher: &Matcher) -> bool {
        let structure = &self.nodes[index].structure;
        let any = |wanted: &[String], have: Option<&str>| {
            wanted.is_empty() || wanted.iter().any(|want| Some(want.as_str()) == have)
        };
        any(&matcher.role, structure.role.as_deref())
            && any(&matcher.subrole, structure.subrole.as_deref())
            && matcher
                .identifier
                .as_ref()
                .is_none_or(|identifier| identifier.matches(structure.identifier.as_deref()))
    }

    /// True when a node at most `has.within` levels below `index` has the wanted structure.
    /// Answered from the scan, no read.
    fn has_below(&self, index: usize, has: &Has) -> bool {
        let below = |node: usize, depth: usize| {
            let children = self.nodes[node].children.iter();
            children.map(move |&child| (child, depth + 1))
        };
        let mut stack: Vec<(usize, usize)> = below(index, 0).collect();
        while let Some((node, depth)) = stack.pop() {
            if self.structure_matches(node, &has.matcher) {
                return true;
            }
            if depth < has.within {
                stack.extend(below(node, depth));
            }
        }
        false
    }

    /// The label list of a matcher, if it has one: one read of title and description.
    fn label_matches<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        matcher: &Matcher,
        meter: &mut Meter,
    ) -> Result<bool, Discard> {
        let Some(labels) = &matcher.label else {
            return Ok(true);
        };
        let texts = self.texts(
            source,
            index,
            &[TextAttr::Title, TextAttr::Description],
            meter,
        )?;
        Ok(texts
            .iter()
            .flatten()
            .any(|text| labels.iter().any(|label| label == text)))
    }

    fn texts<S: Source<Node = H>>(
        &mut self,
        source: &mut S,
        index: usize,
        attrs: &[TextAttr],
        meter: &mut Meter,
    ) -> Result<Vec<Option<String>>, Discard> {
        let missing: Vec<TextAttr> = attrs
            .iter()
            .copied()
            .filter(|attr| self.nodes[index].texts[slot(*attr)].is_none())
            .collect();
        if !missing.is_empty() {
            meter.check_time()?;
            let values = source
                .texts(&self.nodes[index].handle, &missing)
                .map_err(Discard::Read)?;
            self.text_reads += 1;
            meter.check_time()?;
            let mut values = values.into_iter();
            for attr in missing {
                self.nodes[index].texts[slot(attr)] = Some(values.next().flatten());
            }
        }
        Ok(attrs
            .iter()
            .map(|attr| self.nodes[index].texts[slot(*attr)].clone().flatten())
            .collect())
    }
}
