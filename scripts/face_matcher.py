#!/usr/bin/env python3
"""
Face matching script using face_recognition library
Usage: python3 face_matcher.py <video_frame_path> <profile_photo_path>
"""

import sys
import face_recognition
from PIL import Image
import json

def match_faces(frame_path, profile_path):
    try:
        # Load images
        frame_image = face_recognition.load_image_file(frame_path)
        profile_image = face_recognition.load_image_file(profile_path)
        
        # Get face encodings
        frame_encodings = face_recognition.face_encodings(frame_image)
        profile_encodings = face_recognition.face_encodings(profile_image)
        
        if len(frame_encodings) == 0:
            return {
                "success": False,
                "error": "No face detected in verification video"
            }
        
        if len(profile_encodings) == 0:
            return {
                "success": False,
                "error": "No face detected in profile photo"
            }
        
        if len(frame_encodings) > 1:
            return {
                "success": False,
                "error": "Multiple faces detected in video"
            }
        
        # Compare faces
        frame_encoding = frame_encodings[0]
        profile_encoding = profile_encodings[0]
        
        # Calculate face distance (lower = more similar)
        face_distance = face_recognition.face_distance([profile_encoding], frame_encoding)[0]
        
        # Convert to similarity score (0-1, higher = more similar)
        similarity = 1 - face_distance
        
        return {
            "success": True,
            "similarity": float(similarity),
            "match": similarity >= 0.6  # 60% threshold
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({
            "success": False,
            "error": "Usage: python3 face_matcher.py <frame_path> <profile_path>"
        }))
        sys.exit(1)
    
    result = match_faces(sys.argv[1], sys.argv[2])
    print(json.dumps(result))
