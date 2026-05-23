import re
import difflib
import logging

class SmartReorder:
    """
    Utility for organizing playlists by grouping similar titles and ordering by season/episode.
    """
    
    # Regex patterns for extraction
    SEASON_REGEX = re.compile(r'(?:Season\s*(\d+)|S(\d+))', re.IGNORECASE)
    EPISODE_REGEX = re.compile(r'(?:e(\d+)|Episode\s*(\d+)|(?:\s|^)(\d+)(?:\s|$))', re.IGNORECASE)
    
    def __init__(self, threshold=0.85):
        self.threshold = threshold

    def normalize_title(self, title):
        """
        Removes season and episode indicators for similarity comparison.
        """
        if not title:
            return ""
        
        # Remove Season indicators
        normalized = self.SEASON_REGEX.sub('', title)
        # Remove Episode indicators
        normalized = self.EPISODE_REGEX.sub('', normalized)
        
        # Clean up whitespace and special characters
        normalized = re.sub(r'[\s\-_.,|\[\](){}]+', ' ', normalized).strip().lower()
        return normalized

    def extract_metadata(self, title):
        """
        Extracts season and episode numbers from a title.
        """
        season = 0
        episode = 0.0
        
        s_match = self.SEASON_REGEX.search(title)
        if s_match:
            # Groups 1 or 2 depending on which part of the regex matched
            season = int(s_match.group(1) or s_match.group(2))
            
        e_match = self.EPISODE_REGEX.search(title)
        if e_match:
            # Groups 1, 2, or 3
            val = e_match.group(1) or e_match.group(2) or e_match.group(3)
            try:
                episode = float(val)
            except ValueError:
                pass
                
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
