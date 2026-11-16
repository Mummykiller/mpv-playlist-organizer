import re
import difflib
import logging

class SmartReorder:
    """
    Utility for organizing playlists by grouping similar titles and ordering by season/episode.
    """
    
    # Regex patterns for extraction
    SEASON_REGEX = re.compile(r'(?:Season\s*(\d+)|(?<![a-zA-Z0-9])S(\d+))', re.IGNORECASE)
    EXPLICIT_EPISODE_REGEX = re.compile(r'(?<![a-zA-Z])(?:e|ep\.?|episode)\s*(\d+(?:\.\d+)?)', re.IGNORECASE)
    STANDALONE_EPISODE_REGEX = re.compile(r'(?:^|[\s\-_.,|\[\]()])(\d+(?:\.\d+)?)(?=$|[\s\-_.,|\[\]()])')
    
    def __init__(self, threshold=0.85):
        self.threshold = threshold

    def normalize_title(self, title):
        """
        Removes season and episode indicators for similarity comparison.
        """
        if not title:
            return ""
        
        # Remove Season indicators first
        normalized = self.SEASON_REGEX.sub('', title)
        # Remove Episode indicators: explicit first, otherwise standalone (only the episode match)
        if self.EXPLICIT_EPISODE_REGEX.search(normalized):
            normalized = self.EXPLICIT_EPISODE_REGEX.sub('', normalized)
        else:
            matches = list(self.STANDALONE_EPISODE_REGEX.finditer(normalized))
            if len(matches) > 1:
                # Multiple numbers (e.g. "86 - 05" or "Mob Psycho 100 - 05"): strip only the last number (the episode)
                last = matches[-1]
                normalized = normalized[:last.start(1)] + normalized[last.end(1):]
            elif len(matches) == 1:
                # Single standalone number: strip it unless doing so leaves the title empty
                m = matches[0]
                candidate = normalized[:m.start(1)] + normalized[m.end(1):]
                if re.sub(r'[\s\-_.,|\[\](){}]+', ' ', candidate).strip():
                    normalized = candidate
        
        # Clean up whitespace and special characters
        normalized = re.sub(r'[\s\-_.,|\[\](){}]+', ' ', normalized).strip().lower()
        return normalized

    def extract_metadata(self, title):
        """
        Extracts season and episode numbers from a title.
        """
        season = 0
        episode = 0.0
        
        if not title:
            return season, episode

        s_match = self.SEASON_REGEX.search(title)
        if s_match:
            # Groups 1 or 2 depending on which part of the regex matched
            season = int(s_match.group(1) or s_match.group(2))
            
        # Strip matched season text before running episode matching so "Season 2 - 05" doesn't match "2"
        cleaned_title = self.SEASON_REGEX.sub(' ', title)
        
        # Test explicit episode patterns first before falling back to standalone numbers
        e_match = self.EXPLICIT_EPISODE_REGEX.search(cleaned_title)
        val = None
        if e_match:
            val = e_match.group(1)
        else:
            standalone_matches = list(self.STANDALONE_EPISODE_REGEX.finditer(cleaned_title))
            if standalone_matches:
                # Use the last standalone number so show titles with numbers ("86 - 05", "Mob Psycho 100 - 02") pick the episode
                val = standalone_matches[-1].group(1)

        if val is not None:
            try:
                episode = float(val)
            except (ValueError, TypeError) as e:
                logging.debug(f"[SMART_REORDER] Could not convert episode '{val}' to float: {e}")
                
        return season, episode

    def are_similar(self, title1, title2):
        """
        Checks if two titles are similar based on the threshold.
        """
        norm1 = self.normalize_title(title1)
        norm2 = self.normalize_title(title2)
        
        if not norm1 or not norm2:
            return False
            
        ratio = difflib.SequenceMatcher(None, norm1, norm2).ratio()
        return ratio >= self.threshold

    def organize(self, playlist):
        """
        Organizes a playlist list.
        Each item is expected to be a dict with at least a 'title' key.
        """
        if not playlist:
            return []

        # 1. Enrich items with metadata and normalized titles
        enriched = []
        for i, item in enumerate(playlist):
            title = item.get('title', '')
            season, episode = self.extract_metadata(title)
            enriched.append({
                'original_index': i,
                'item': item,
                'norm_title': self.normalize_title(title),
                'season': season,
                'episode': episode
            })

        # 2. Grouping
        groups = []
        for entry in enriched:
            found_group = False
            for group in groups:
                # Compare against the first item in the group
                if self.are_similar(entry['item'].get('title', ''), group[0]['item'].get('title', '')):
                    group.append(entry)
                    found_group = True
                    break
            
            if not found_group:
                groups.append([entry])

        # 3. Sort groups by their original appearance
        groups.sort(key=lambda g: g[0]['original_index'])

        # 4. Sort within groups by Season -> Episode
        final_playlist = []
        for group in groups:
            group.sort(key=lambda e: (e['season'], e['episode']))
            for entry in group:
                final_playlist.append(entry['item'])

        return final_playlist
