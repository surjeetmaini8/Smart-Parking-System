import cv2
import requests
import time
import numpy as np
from datetime import datetime
import os
from dotenv import load_dotenv

load_dotenv()

BACKEND_URL = os.getenv('BACKEND_URL', 'http://localhost:4000/api')
ALPR_INTERNAL_TOKEN = os.getenv('ALPR_INTERNAL_TOKEN', '')
OCR_SERVICE_URL = os.getenv('OCR_SERVICE_URL', 'http://localhost:5000')
LOCATION_ID = int(os.getenv('LOCATION_ID', 1))
CAMERA_ID = os.getenv('CAMERA_ID', 'CAM001')
CAMERA_TYPE = os.getenv('CAMERA_TYPE', 'entry')  
CAPTURE_INTERVAL = int(os.getenv('CAPTURE_INTERVAL', 5))  
VIDEO_SOURCE_RAW = os.getenv('VIDEO_SOURCE', '0')
try:
    VIDEO_SOURCE = int(VIDEO_SOURCE_RAW)
except ValueError:
    VIDEO_SOURCE = VIDEO_SOURCE_RAW  




def detect_motion(frame, prev_frame, threshold=25):
    if prev_frame is None:
        return False
    
    gray1 = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    diff = cv2.absdiff(gray1, gray2)
    _, thresh = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
    
    non_zero = cv2.countNonZero(thresh)
    
    return non_zero > 5000

def recognize_license_plate(image):
    
    try:
        _, img_encoded = cv2.imencode('.jpg', image)
        
        files = {'image': ('plate.jpg', img_encoded.tobytes(), 'image/jpeg')}
        response = requests.post(
            f'{OCR_SERVICE_URL}/recognize',
            files=files,
            timeout=10
        )
        
        if response.status_code == 200:
            return response.json()
        else:
            print(f"OCR service error: {response.status_code}")
            return None
            
    except Exception as e:
        print(f"Error calling OCR service: {e}")
        return None

def send_to_backend(license_plate, image_path, confidence):
    try:
        endpoint = 'entry' if CAMERA_TYPE == 'entry' else 'exit'
        
        data = {
            'licensePlate': license_plate,
            'locationId': LOCATION_ID,
            'imagePath': image_path,
            'cameraId': CAMERA_ID,
            'confidenceScore': confidence
        }
        
        headers = {'X-ALPR-Token': ALPR_INTERNAL_TOKEN} if ALPR_INTERNAL_TOKEN else {}
        response = requests.post(
            f'{BACKEND_URL}/alpr/{endpoint}',
            json=data,
            headers=headers,
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f" {endpoint.upper()} processed: {license_plate}")
            return result
        else:
            print(f"Backend error: {response.status_code}")
            return None
            
    except Exception as e:
        print(f"Error sending to backend: {e}")
        return None

def main():
    """Main camera processing loop"""
    if not ALPR_INTERNAL_TOKEN:
        return

    print(f"🎥 Attempting to open camera {VIDEO_SOURCE}...")
    
    # Release any existing camera connections
    cap = cv2.VideoCapture(VIDEO_SOURCE)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Reduce buffer size
    
    if not cap.isOpened():
        
        return
    
    prev_frame = None
    last_capture_time = 0
    last_plate = None
    last_plate_time = 0
    PLATE_COOLDOWN = max(CAPTURE_INTERVAL, 10)
    
    try:
        while True:
            ret, frame = cap.read()
            
            if not ret:
                print(" Error reading frame")
                break
            
            current_time = time.time()
            
            cv2.imshow(f'Parking Camera - {CAMERA_TYPE.upper()}', frame)
            
            if detect_motion(frame, prev_frame) and \
               (current_time - last_capture_time) >= CAPTURE_INTERVAL:
                
                
                ocr_result = recognize_license_plate(frame)
                
                if ocr_result and ocr_result.get('success'):
                    license_plate = ocr_result.get('license_plate')
                    confidence = ocr_result.get('confidence', 0)
                    image_path = ocr_result.get('image_path', '')
                    
                    print(f" Detected: {license_plate} (Confidence: {confidence:.2%})")
                    
                    backend_result = send_to_backend(license_plate, image_path, confidence)
                    
                    if backend_result and backend_result.get('success'):
                        print(f" {CAMERA_TYPE.upper()} verified for {license_plate}")
                    
                    cv2.putText(
                        frame, 
                        f"Plate: {license_plate}", 
                        (10, 30), 
                        cv2.FONT_HERSHEY_SIMPLEX, 
                        1, 
                        (0, 255, 0), 
                        2
                    )
                else:
                    print("  No license plate detected")
                    cv2.putText(
                        frame, 
                        "No plate detected", 
                        (10, 30), 
                        cv2.FONT_HERSHEY_SIMPLEX, 
                        1, 
                        (0, 0, 255), 
                        2
                    )
                
                last_capture_time = current_time
            
            prev_frame = frame.copy()
            
            if cv2.waitKey(1) & 0xFF == ord('q'):
               print("Stopping camera...")
               break
                
    except KeyboardInterrupt:
        print("\n  Camera stopped by user")
    except Exception as e:
        print(f"\n Error occurred: {e}")
    finally:
        if cap is not None:
            cap.release()
        cv2.destroyAllWindows()
        print("Camera released successfully")
        time.sleep(0.5)

if __name__ == '__main__':
    main()
